"""Each environment's uploads must reach only that environment's worker.

qa and production share one bucket (askwri-data). Both used to fall back to
the `intake/` default, so a file uploaded through production's admin UI was
swept by whichever worker listed it first; qa's worker registered it in qa's
database and moved it out of intake, and production never saw it (2026-11-18).

S3 prefixes match as plain string prefixes, so the environments' intake
prefixes must not start with one another: a worker listing `intake/` also
lists `intake/qa/...`. With disjoint prefixes, each environment's task-role IAM
grants (built from var.intake_s3_prefix) also stop it touching the other's.

The app container must be told the same prefix as its worker, instead of
relying on the route's code default.
"""
import itertools
import re
from pathlib import Path

TERRAFORM = Path(__file__).resolve().parents[2] / "terraform"
ENV_DIR = TERRAFORM / "environments"
ECS_TF = TERRAFORM / "infrastructure" / "ecs.tf"


def _intake_prefixes() -> dict[str, str | None]:
    prefixes = {}
    for tfvars in sorted(ENV_DIR.glob("*.tfvars")):
        m = re.search(r'^\s*intake_s3_prefix\s*=\s*"([^"]*)"', tfvars.read_text(), re.MULTILINE)
        prefixes[tfvars.stem] = m.group(1) if m else None
    return prefixes


def test_every_environment_sets_its_intake_prefix():
    prefixes = _intake_prefixes()
    assert prefixes, f"no tfvars found in {ENV_DIR}"
    missing = [env for env, p in prefixes.items() if not p]
    assert not missing, f"intake_s3_prefix not set in: {missing}"


def test_environment_intake_prefixes_do_not_overlap():
    prefixes = {env: p for env, p in _intake_prefixes().items() if p}
    for (a, pa), (b, pb) in itertools.combinations(prefixes.items(), 2):
        assert not (pa.startswith(pb) or pb.startswith(pa)), (
            f"{a} ({pa!r}) and {b} ({pb!r}) intake prefixes overlap: "
            "one environment's worker would sweep the other's uploads"
        )


def test_app_container_is_given_the_intake_prefix():
    text = ECS_TF.read_text()
    m = re.search(r'resource "aws_ecs_task_definition" "app"(.*?)\nresource "', text, re.DOTALL)
    assert m, "aws_ecs_task_definition.app not found in ecs.tf"
    assert re.search(
        r'name\s*=\s*"INTAKE_S3_PREFIX"\s*value\s*=\s*var\.intake_s3_prefix', m.group(1)
    ), "app container does not set INTAKE_S3_PREFIX from var.intake_s3_prefix"
