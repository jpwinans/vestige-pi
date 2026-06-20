# Changelog

## [Unreleased]

### Added

- Initial local multi-model coding pipeline: a deterministic orchestrator that drives a local
  Qwen implementer and Gemma reviewer through plan → red-check → implement → Gate A → Gate B →
  revise → escalate → done, with `/build` (coding-agent extension) and `pipeline run` (CLI)
  entrypoints.
