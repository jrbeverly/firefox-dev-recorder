# Firefox Dev Recorder

> [!WARNING]
> **AI-authored:** This change was autonomously planned and implemented by an AI software factory from a human-authored specification, with possible subsequent human review or modification.

> [!WARNING]
> This experiment is effectively abandoned. The generated material is retained primarily as a research artifact.

A Firefox extension that captures software review sessions materials (audio, navigation history, interactions, markers, screenshots). This can then be exported as a structured ZIP bundle for downstream AI processing into issues for remediation.

The extension records _what you see and say_ while reviewing software. It does not transcribe, analyze, or generate anything itself. Its sole responsibility is context capture and export.

## Notes

- This direction is very promising as a means of aggregating musings for remediating problems
- Future direction could automatically publish materials to an endpoint, using codebase & notes to yield actions (would need a post-processing write-up)
- Same model could apply to reviewing the code within the browser (`gitea/github/gitlab`), for faster AI resolution
- Terminology could be devised to assist with calling out common styles of error (SLIPA)

Overall the result from the factory is very workable. Needs more development to realize the full potential.
