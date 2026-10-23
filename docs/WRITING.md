# Documentation checks

Use [ASD-STE100 Issue 9](https://www.asd-ste100.org/) for new and revised documentation.
Keep technical meanings, commands, identifiers, limits, and security conditions.
Use the same term for the same item.
Keep exact quotations, legal text, and historical test fixtures unchanged.

## Required PR checks

The `docs-ste / ste-cli` and `docs-ste / vale` jobs check documentation on each PR.
The required `guard` job accepts only a successful result from both jobs.
Failed, canceled, skipped, and missing results stop the guard.
The policy protects the workflow, caller, configurations, vocabulary, and tests.

Both jobs discover Markdown files across the repository, including new and hidden paths.
They extract `description`, `summary`, and `title` strings from JSON OpenAPI and Swagger specifications.
The repository has no such specifications at the time of this change.
The extraction tests use a sample specification.

The jobs exclude legal files, changelogs, build output, installed dependencies, and downloaded styles.
They also exclude the historical `baseline-companion-skill.md` test fixture.
Current skill sources and the generated current skill remain in scope.

## Compliance limits

Successful checks do not prove full Issue 9 compliance.
ste-cli checks a subset of writing rules.
Vale checks the STE style from vale-llm-slop.
Neither configuration checks every word against the official Issue 9 dictionary.
Reviewers must check word meanings, parts of speech, technical terms, and technical accuracy.

Warnings and errors fail the checks.
Informational findings do not fail them.
Code examples, exact quotations, and legal text need separate review for their applicable purpose.
The extraction covers JSON specifications.
It does not extract prose from YAML specifications or source comments.

The policy checks run from `main`.
This PR cannot activate its own policy changes.
Until the reviewed policy is active, the existing guard can reject the new workflow and configuration hashes.
