# Security Policy

This document explains the security model behind ton and where the boundaries are.

ton is a local assistant that runs within the security boundary of the user
running it. It is the user's responsibility to monitor its operations or to
contain it within a container, virtual machine, or other sandbox.

ton treats the local user account and files writable by that account as inside
the same trust boundary as the ton process itself. If an attacker can modify files
under the user's home directory, workspace, shell startup files, environment, or
ton configuration, they can generally influence ton or other local developer
tools. Reports that depend on such prior local write access are not security
vulnerabilities unless they demonstrate how ton grants that write access or
crosses an operating-system privilege boundary.

ton relies on users installing trustworthy extensions and loading trustworthy
skills, and only using ton within trusted repositories. Files such as `AGENTS.md`
or instructions in comments can prompt-inject the agent trivially, and this
cannot be fully protected against.

## Reporting a Vulnerability

If you believe you found a security vulnerability in ton or another package in
this repository, report it privately through GitHub Security Advisories for this
repository.

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- Affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports. Reports are reviewed
and disclosure is coordinated as appropriate.

## Scope

Security issues in the distributed packages, command-line tools, TUI, desktop
app, APIs, and repository code are in scope.

## Out Of Scope

- Local code execution or sandboxing behavior (ton intentionally does not have a sandbox)
- Behavior of extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Issues caused by non-trustworthy MITM proxies
- Public internet exposure of a ton installation
- Prompt injection attacks
- Exposed secrets that are third-party or user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files,
  directories, symlinks, environment variables, shell configuration, or other
  user-controlled local state on the target machine. This includes `~/.ton`,
  `~/.ton/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions,
  extension configuration, dotfiles, and files synchronized through NFS, roaming
  profiles, or dotfile managers, unless the report shows how ton itself grants
  that access.
- Issues caused by intentionally weakened user configuration.
- Resource or denial-of-service claims that require trusted local input or
  configuration against ton.
- Reports about malicious model output.
- User-approved or user-initiated local actions presented as vulnerabilities.

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass
with demonstrated impact. Reports that only show expected local-agent behavior,
prompt injection, or a malicious trusted extension or skill are not security
vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted ton
configuration file cause ton to execute commands, load attacker-controlled tools,
send credentials to an attacker-controlled endpoint, or otherwise change behavior
is out of scope.

When possible, include the exact affected path, package version or commit SHA,
configuration, and a proof of concept against the latest release or latest
`main`. For dependency reports, include evidence that the shipped dependency is
affected and that the issue is reachable through ton.
