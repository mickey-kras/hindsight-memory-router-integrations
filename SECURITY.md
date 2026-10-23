# Security policy

Report vulnerabilities through a private GitHub security advisory for this repository.

## Dependency licenses

Dependency review blocks high and critical vulnerabilities in runtime, development,
and unknown scopes. Review license compatibility manually. CI does not certify it.

- Separately executed CI tools (including SonarSource's scanner) do not need a
  license exception for each version. Review actual changes to their license or usage.
- Before you add or change a dependency in a binary, package or container, review its terms. Include linking, bundling, notices, source duties and relinking duties.
- Review GPL, AGPL, LGPL, SSPL, custom and unknown terms in their context. Do not reject them automatically.

  Record the decision and required notices in the PR. Update third-party notices to match the decision.
- An existing dependency is not proof of approval. Before you rely on its license, review any shipped dependency without a recorded decision. If manual review is necessary, disable auto-merge.

The repository's own license does not replace dependency licenses.

