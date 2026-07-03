# 🤖 Flutter Code Reviewer (Danger JS + Gemini API)

An automated code review pipeline designed for Flutter/Dart repositories. Powered by **Danger JS** and the **Google Gemini API** (`gemini-2.5-flash`), this script automatically reviews GitLab Merge Requests (MRs), triages issues, generates draft changelogs, and checks project configuration health.

---

## 🚀 Key Features

*   **AI Code Triage**: Reviews Dart diffs and assigns severity tiers (`🛑 P0`, `⚠️ P1`, `♻️ P2`, `🧊 P3`) using a specialized persona.
*   **Default Persona (Caveman-Lite)**: By default, reviews are written in a blunt, simple, "caveman-lite" tone to keep comments short, clear, and direct.
*   **Automatic CHANGELOG Generator**: Suggests a user-facing release note for modified files if the developer forgot to update `CHANGELOG.md`.
*   **Build Integrity Guards**: Fails the pipeline if `pubspec.yaml` is modified without updating `pubspec.lock`.
*   **Pull Request Hygiene**: Flags Draft/WIP merge requests, excessive changes (>20 files), and left-behind `print()` or `TODO` statements.
*   **Token Usage Tracking**: Reports a complete token usage breakdown in the MR comments to help monitor API costs.

---

## 🛠️ Getting Started

### 1. Prerequisites
Ensure you have Node.js installed, then install the project dependencies:
```bash
npm install
```

### 2. Run the Review Script
To run the script locally or within your GitLab CI/CD runner:
```bash
npx danger run --dangerfile danger.js
```

---

## 🔧 CI/CD Setup (GitLab)

### Required Environment Variables

Add these to your GitLab project under **Settings > CI/CD > Variables**:

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google Gemini API key. Get one from [AI Studio](https://aistudio.google.com/apikey). |
| `DANGER_GITLAB_API_TOKEN` | Yes | A GitLab **Personal Access Token** with `api` scope. This lets Danger post comments on MRs. |

> **Do not** mark these as "masked" if you're debugging. Masked variables work fine in production but can cause issues if you need to troubleshoot pipeline output.

### Setting Up `DANGER_GITLAB_API_TOKEN`

1. In GitLab, go to **User Settings > Access Tokens** (or have an admin create a **Project Access Token**).
2. Create a token with the **`api`** scope.
3. Copy the token and add it as a CI/CD variable in your project.

> For project-level tokens, go to **Settings > Access Tokens** in the project, and assign the **`api`** role.

### GitLab CI/CD Pipeline

Add the review job to your `.gitlab-ci.yml`:

```yaml
code-review:
  image: node:20
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  before_script:
    - npm install
  script:
    - npx danger run --dangerfile danger.js
```

Danger JS automatically detects the merge request from GitLab CI environment variables (`CI_MERGE_REQUEST_IID`). No extra configuration is needed for MR identification.

### GitHub CI (Alternative)

If using GitHub Actions instead of GitLab:

```yaml
name: Code Review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npx danger run --dangerfile danger.js
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

### Environment Variable Summary

| Variable | Where to set | Used by |
|---|---|---|
| `GEMINI_API_KEY` | GitLab CI/CD Variables | `danger.js` — calls Gemini API for AI review |
| `DANGER_GITLAB_API_TOKEN` | GitLab CI/CD Variables | Danger JS — posts inline MR comments |
| `GITHUB_TOKEN` | GitHub Actions secrets | Danger JS — posts PR comments (GitHub only) |

> **Tip:** Never commit tokens to your repository. Always use CI/CD variables or secrets managers.

---

## 🎨 Tailoring Your Team's Prompt & Persona

Different teams have different styles. By default, the script defines the prompt inline within the `reviewPerFileWithGeminiAI` function in **[danger.js](file:///Users/makoy/Documents/Projects/node/code-reviewer/danger.js)**. Dev teams can customize the prompt behavior by directly editing the `prompt` string template.

### 1. Default Persona: Caveman-Lite
The default prompt implements JuliusBrussee's official `caveman-review` style:
*   **Terse and Actionable**: Write review comments in `${file}:L<line>: <severity> <problem>. <fix>.` format. One line per finding. No throat-clearing.
*   **Drop**: Unnecessary hedging ("I noticed that", "It seems like", "Perhaps", "Maybe") or restating what the code does.
*   **Keep**: Exact line numbers, exact symbol names in backticks, and concrete fixes.
*   **Severity Prefixes**:
    *   `🔴 bug:` — broken behavior, will cause incident.
    *   `🟡 risk:` — works but fragile (race, missing null check, swallowed error).
    *   `🔵 nit:` — style, naming, micro-optimization. Author can ignore.
    *   `❓ q:` — genuine question, not a suggestion.

### 2. Customizing Tone
To change the persona, simply modify the `prompt` template literal inside the review loop. For example, to switch to a **Friendly Mentor** persona, you could change the instructions to:
```javascript
const prompt = `
You are a friendly and supportive Flutter/Dart mentor. Analyze the diff for \`\${file}\`.

Guidelines:
- Explain the "why" behind your suggestions.
- Be encouraging and gentle.
- Format comments as: "\${file}:L<line>: <suggestion>"

Diff for \`\${file}\` (with line numbers prefixed):
\`\`\`diff
\${formattedDiff}
\`\`\`
`;
```

### 3. Line Number Verification
The script parses the caveman-format feedback and extracts line numbers:
* If a line number is found, Danger JS posts an **inline comment** directly on the file diff line (threaded review).
* If no line number is found, it falls back to a **general MR comment** format: `- **<file>**: <comment>`.


---

## ⚙️ How it Works

The script executes the following functions sequentially:
1.  **`reviewMrMetadata`**: Ensures the Merge Request title and description meet length requirements and are not marked Draft/WIP.
2.  **`checkDeletedFiles`**: Warns about any deleted files.
3.  **`reviewFileChanges`**: Checks if `CHANGELOG.md` needs to be updated and verifies that `pubspec.lock` matches `pubspec.yaml`.
4.  **`reviewCodeContent`**: Scans the raw diffs for syntax issues like `print()` and `TODO` comments.
5.  **`reviewPerFileWithGeminiAI`**: Sends structured diffs to `gemini-2.5-flash` for automated quality review using the configured tone.
6.  **`reportTotalTokenUsage`**: Calculates and prints API token metrics to monitor usage patterns.
