"""B2 — the ecs_task_s3 IAM policy grants s3:PutObject on the intake prefix.

Regression test for finding B2 in docs/plans/2026-07-01-doc-mgmt-review-findings.md.

The bug: src/app/api/admin/intake/route.ts uploads PDFs to the S3 `intake/`
prefix, but the shared `ecs_task_s3` task-role policy granted only
`s3:GetObject`+`s3:DeleteObject` on `intake/*` (the `WorkerIntakeObjects`
statement) and `s3:PutObject` only on `documents/*` and `eval-data/*`.
So browser-based intake upload returned AccessDenied (500) in prod, while
local-dev `INTAKE_LOCAL_DIR` masked it.

The fix: a new `PutIntakeObjects` statement grants `s3:PutObject` on
`arn:aws:s3:::${var.documents_s3_bucket}/${var.intake_s3_prefix}*`.

This is a static check, not an evaluation of the policy against AWS — IAM is
authoritative only at runtime. The honest local proof is that the grant exists
in the HCL with the right Action + Resource shape. Full validation
(`terraform validate` + `terraform plan` against real AWS, or a policy-as-code
linter like checkov/tfsec) belongs in CI; this test is the fast, dependency-free
gate that the grant is present and scoped to the intake prefix.

If `python-hcl2` is installed, the test parses the HCL structurally; otherwise
it falls back to a conservative regex that matches the existing statement style.
Both paths assert the same property.
"""
import re
from pathlib import Path

import pytest

ECS_TF = (
    Path(__file__).resolve().parents[2]
    / "terraform"
    / "infrastructure"
    / "ecs.tf"
)


def _policy_block_text() -> str:
    """Return the raw text of the `aws_iam_role_policy "ecs_task_s3"` block.

    We slice it out so the assertions are scoped to THIS policy (the file has
    several IAM resources) and a future edit to a different policy can't make
    this test pass spuriously.
    """
    text = ECS_TF.read_text()
    # Match from the resource header to the closing `})` of its jsonencode call.
    m = re.search(
        r'resource "aws_iam_role_policy" "ecs_task_s3"\s*\{.*?policy\s*=\s*jsonencode\(\{(.*?)\}\)\s*\}',
        text,
        re.DOTALL,
    )
    assert m, (
        "could not locate the `aws_iam_role_policy \"ecs_task_s3\"` "
        "jsonencode block in ecs.tf — did the resource get renamed?"
    )
    return m.group(1)


def _statements(policy_text: str) -> list[dict]:
    """Extract statements as {Sid, Action, Resource, Effect} dicts.

    Uses python-hcl2 if available (proper parse); otherwise a regex that
    matches the existing statement style (each statement is an HCL object
    literal with Sid/Effect/Action/Resource keys).
    """
    try:
        import hcl2  # type: ignore
        import io
        loaded = hcl2.load(io.StringIO(
            'policy = ' + '{' + policy_text + '}'
        ))
        stmts = loaded.get("policy", {}).get("statement", [])
        # hcl2 lowercases keys and turns single-element lists into scalars.
        norm = []
        for s in stmts:
            actions = s.get("action", [])
            if isinstance(actions, str):
                actions = [actions]
            resources = s.get("resource", [])
            if isinstance(resources, str):
                resources = [resources]
            norm.append({
                "Sid": s.get("sid"),
                "Effect": s.get("effect"),
                "Action": actions,
                "Resource": resources,
            })
        return norm
    except ImportError:
        # Regex fallback — matches the file's current statement style. Each
        # statement is a brace block with a quoted Sid.
        stmts = []
        for sm in re.finditer(
            r'\{\s*Sid\s*=\s*"([^"]*)"\s*Effect\s*=\s*"([^"]*)"\s*'
            r'Action\s*=\s*\[(.*?)\]\s*Resource\s*=\s*(\[.*?\]|"[^"]*")',
            policy_text,
            re.DOTALL,
        ):
            sid, effect, action_body, resource_body = sm.groups()
            actions = re.findall(r'"([^"]*)"', action_body)
            if resource_body.startswith("["):
                resources = re.findall(r'"([^"]*)"', resource_body)
            else:
                resources = [resource_body.strip('"')]
            stmts.append(
                {"Sid": sid, "Effect": effect, "Action": actions, "Resource": resources}
            )
        return stmts


def test_b2_putobject_granted_on_intake_prefix():
    """A PutObject Allow statement exists whose Resource ends in the intake prefix.

    This is the core B2 fix. The intake route PUTs to
    `s3://${DOCUMENTS_S3_BUCKET}/${INTAKE_S3_PREFIX}<name>`; without an Allow
    on that prefix the PUT 403s in prod.
    """
    stmts = _statements(_policy_block_text())
    put_on_intake = [
        s for s in stmts
        if s["Effect"] == "Allow"
        and "s3:PutObject" in s["Action"]
        and any(
            re.search(r"\$\{var\.intake_s3_prefix\}\*?$", r)
            or r.endswith("${var.intake_s3_prefix}*")
            for r in s["Resource"]
        )
    ]
    assert put_on_intake, (
        "No Allow statement grants s3:PutObject on the intake prefix "
        "(regression B2). Statements found:\n"
        + repr(stmts)
    )


def test_b2_intake_get_delete_still_present():
    """The pre-existing WorkerIntakeObjects Get+Delete grant is intact.

    The fix ADDS PutObject; it must not remove the worker's existing Get/Delete
    on the same prefix (the worker drains intake after processing). This guards
    against a careless edit that swaps rather than adds.
    """
    stmts = _statements(_policy_block_text())
    getdel_on_intake = [
        s for s in stmts
        if s["Effect"] == "Allow"
        and {"s3:GetObject", "s3:DeleteObject"}.issubset(set(s["Action"]))
        and any(
            r.endswith("${var.intake_s3_prefix}*") for r in s["Resource"]
        )
    ]
    assert getdel_on_intake, (
        "WorkerIntakeObjects (GetObject+DeleteObject on intake/*) is missing "
        "— the B2 fix should have ADDED PutObject, not removed Get/Delete."
    )


def test_b2_putobject_not_granted_on_unintended_prefixes():
    """The new PutObject grant is scoped to intake only, not accidentally broader.

    Catches a copy-paste that grants PutObject on `documents/*` or `eval-data/*`
    under the new Sid (those already have their own PutObject statements; a
    second grant isn't harmful but would indicate the fix was mis-scoped).
    The property we want: every Resource in the new PutIntakeObjects statement
    references intake_s3_prefix.
    """
    stmts = _statements(_policy_block_text())
    new_stmts = [
        s for s in stmts
        if s["Sid"] == "PutIntakeObjects"
        or (
            s["Effect"] == "Allow"
            and "s3:PutObject" in s["Action"]
            and any("intake_s3_prefix" in r for r in s["Resource"])
        )
    ]
    assert new_stmts, "PutIntakeObjects statement not found (see test_b2_putobject_granted_on_intake_prefix)"
    for s in new_stmts:
        for r in s["Resource"]:
            assert "intake_s3_prefix" in r, (
                f"PutIntakeObjects grants PutObject on a non-intake resource: {r}\n"
                f"full statement: {s}"
            )
