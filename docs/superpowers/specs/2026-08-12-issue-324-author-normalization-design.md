# Issue 324 AI Author Normalization Design

## Context

Issue 324 reports inconsistent DMS metadata produced during document ingestion. Writer tracing shows that only the author-name problem belongs to the AI extraction path:

- `authors` is extracted by the parse-stage model and stored with `llm` provenance.
- `date_published` is supplied by CSV import or a person. The importer interprets legacy dates as month/day/year.
- `publication_title` is supplied by CSV import or a person. The worker does not derive it from `title`.

This change therefore addresses author normalization only. It must not change date parsing, publication-title mapping, database columns, or admin editing behavior.

## Goal

Store every AI-extracted personal author in the DMS convention `Family name, Given names`, separated from other authors by `; `, including authors transliterated from Chinese and other non-Latin scripts.

## Approach

Replace the model's free-form `authors` string with a structured array of author objects in the existing parse-stage metadata call. Each object contains nullable `family_name`, `given_names`, and `organization_name` fields. Strict structured output requires all three keys; the prompt requires each item to represent either a person or an organization, never both.

The model remains responsible for identifying name parts and for transliteration. The application becomes responsible for display order and punctuation:

- A person with both parts becomes `family_name, given_names`.
- A person with only one determinable part is preserved as that single value without an invented comma.
- An organization is preserved as `organization_name` without reordering.
- Blank or internally invalid items are discarded.
- Formatted entries are joined with `; `.
- If no valid entries remain, `authors` becomes `None`, so the existing write loop leaves the stored value unchanged.

The formatter returns the current database contract, `str | None`. No migration or consumer change is required.

## Prompt Contract

The metadata-extraction prompt will require the model to:

1. Prefer a Latin-script or romanized spelling printed by the document.
2. Otherwise transliterate names into the Latin alphabet.
3. Separate family name from given names semantically, regardless of the source language's printed order.
4. Use `organization_name` for group or institutional authors rather than forcing them into personal-name fields.
5. Return `null` for name parts that cannot be determined instead of guessing.

Examples will include Chinese names whose final stored forms are `Xue, Lulu` and `Chen, Ke`.

## Data Flow and Ownership

The parse stage continues making one metadata-extraction call. The response is normalized immediately after `chat_json` returns:

1. Structured author objects enter a small pure formatter.
2. The formatter produces the existing semicolon-delimited string.
3. The existing provenance guard writes it only when `metadata_source.authors` is absent or `llm`.
4. The existing audit path records a genuine author change.

Values marked `external` or `human` remain protected. Re-ingestion may refresh only an existing AI-owned author value, matching current behavior.

## Error Handling

Malformed author entries must not fail the parse stage. The formatter ignores entries that are not objects, trims string values, and drops items with neither a usable personal name nor an organization name. Other metadata fields from the same response remain usable.

The existing best-effort boundary around metadata extraction remains unchanged: an API or parsing failure logs a warning and allows the parse stage to continue.

## Testing

Focused unit tests will cover:

- The structured schema uses an array of author objects rather than a free-form string.
- Chinese personal names are formatted deterministically as `Xue, Lulu; Chen, Ke`.
- A romanization supplied by the document is preferred by the prompt contract.
- A single-name person remains unpunctuated.
- An organizational author remains unchanged.
- Blank and malformed entries are discarded without failing extraction.
- Existing integration tests continue proving that `human` and `external` author values are not overwritten and that `llm` values can be refreshed.

The focused Python test module will run first, followed by the full Python and Jest suites. Database-dependent tests may remain skipped when their documented local services are unavailable.

## Out of Scope

- Changing or inferring `date_published`.
- Changing or inferring `publication_title`.
- Repairing already stored author values without re-ingestion.
- Adding a second model call.
- Changing the database representation or admin form.
- Attempting deterministic cultural surname inference in application code; semantic name splitting remains the model's responsibility.
