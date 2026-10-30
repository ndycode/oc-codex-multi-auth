# Documentation Map

One-page index of every doc in this repository. `dist/` is build output, never a doc source.

## Repository Root

| File | Purpose |
| --- | --- |
| `README.md` | User entry point: what it is, install, feature tour |
| `CHANGELOG.md` | Release history |
| `CONTRIBUTING.md` | Contribution workflow |
| `SECURITY.md` | Security reporting policy |
| `CODE_OF_CONDUCT.md` | Conduct expectations and reporting |
| `AGENTS.md` | Agent-facing project knowledge base |

## docs/ — Site + Guides

```text
docs/
├── _config.yml               # docs site config
├── index.md                  # product overview (what it does at runtime)
├── README.md                 # docs portal navigation
├── DOCUMENTATION.md          # this file
├── STYLE_GUIDE.md            # docs voice, naming, and formatting rules
├── architecture.md           # public architecture overview
├── getting-started.md        # install + auth + first run
├── upgrade.md                # version upgrades + retired-name migration
├── tools-and-cli.md          # 24 codex-* tools + standalone CLI
├── configuration.md          # config reference
├── plan-allotments.md        # ChatGPT plan -> allotment multiplier map
├── troubleshooting.md        # operational debugging
├── faq.md                    # short common answers
├── privacy.md                # data handling notes
├── OPENCODE_PR_PROPOSAL.md   # upstream OpenCode proposal notes
└── development/              # maintainer docs
    ├── ARCHITECTURE.md            # module map + invariants
    ├── CONFIG_FIELDS.md           # config field semantics
    ├── CONFIG_FLOW.md             # config resolution internals
    ├── TESTING.md                 # testing strategy and commands
    ├── TUI_PARITY_CHECKLIST.md    # auth dashboard parity checks
    └── GITHUB_DISCOVERABILITY.md  # repo description, topics, search wording
```

## config/ — Shipped Templates

| File | Purpose |
| --- | --- |
| `config/opencode-modern.json` | variant-picker template (12 bases / 65 variants) |
| `config/opencode-legacy.json` | explicit-only template (65 entries) |
| `config/minimal-opencode.json` | minimal debug template |
| `config/README.md` | template selection + install modes |

## Nested Agent Guides

- `lib/AGENTS.md` — runtime module map
- `lib/tools/AGENTS.md` — per-tool factory pattern
- `test/AGENTS.md` — test-suite conventions
- `skills/oc-codex-setup/SKILL.md` — repo-local setup skill

## Keeping Docs Honest

`test/doc-parity.test.ts` pins the claims that drift: catalog counts, tool counts, auth labels, repo-path references, markdown links, npm scripts, and package metadata. Update docs and that test together when a documented contract changes.

Start points: `README.md` and `docs/getting-started.md` for users; `docs/architecture.md` then `docs/development/ARCHITECTURE.md` for how it works.
