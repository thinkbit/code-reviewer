// dangerfile.js

import {
    danger,
    warn,
    fail,
    message,
    markdown
} from "danger";
import axios from "axios";

// =============================================================================
// Helper Variables & Functions
// =============================================================================

const git = danger.git;
const mr = danger.gitlab.mr;

const modifiedFiles = git.modified_files;
const createdFiles = git.created_files;
const allChangedFiles = [...modifiedFiles, ...createdFiles];

// A global tracker for Gemini API token usage.
const tokenTracker = {
    total: 0,
    calls: 0,
    requests: [],
};

const hasChangesIn = (folder, files) => files.some(file => file.startsWith(folder));
const isGeneratedFile = (file) => file.endsWith('.g.dart') || file.endsWith('.freezed.dart');

/**
 * A main function to execute all checks.
 */
async function runCodeReview() {
    console.log("Starting Flutter code review...");
    console.log(GEMINI_API_KEY);
    reviewMrMetadata();
    checkDeletedFiles();
    await reviewFileChanges();
    await reviewCodeContent();
    await reviewPerFileWithGeminiAI();

    // Report the total token usage at the end.
    reportTotalTokenUsage();
    
    console.log("Flutter code review finished.");
}


// =============================================================================
// Gemini AI Helper (DRY Principle)
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * A reusable function to call the Google Gemini API.
 * It tracks token usage as a side effect without changing the return value.
 * @param {string} prompt The prompt to send to the model.
 * @param {string} purpose A friendly name for the request for logging purposes.
 * @returns {Promise<string|null>} The generated text content or null if an error occurs.
 */
async function callGemini(prompt, purpose = 'Generic Request') {
    if (!GEMINI_API_KEY) {
        console.log("GEMINI_API_KEY not found. Skipping API call.");
        return null;
    }

    

    try {
        const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
        const response = await axios.post(
            endpoint, {
            contents: [{
                parts: [{
                    text: prompt
                }]
            }],
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY,
            },
        }
        );

        const responseData = response.data;

        // SIDE EFFECT: Update the global token tracker.
        if (responseData.usageMetadata && responseData.usageMetadata.totalTokenCount) {
            const tokenCount = responseData.usageMetadata.totalTokenCount;
            tokenTracker.total += tokenCount;
            tokenTracker.calls++;
            tokenTracker.requests.push({
                purpose,
                tokenCount
            });
            console.log(`Gemini call [${purpose}] successful. Tokens used: ${tokenCount}`);
        }

        // RETURN ORIGINAL VALUE: Return the text content directly.
        if (responseData.candidates && responseData.candidates[0].content) {
            return responseData.candidates[0].content.parts[0].text;
        } else {
            console.error("Invalid response structure from Gemini API:", responseData);
            return null;
        }

    } catch (error) {
        console.error(`Error calling Gemini API for [${purpose}]:`, error.response ? error.response.data : error.message);
        return null;
    }
}


// =============================================================================
// Checks Section
// =============================================================================

function checkDeletedFiles() {
    const deletedFiles = danger.git.deleted_files;
    if (deletedFiles.length === 0) return;

    const message = `
### 🗑️ Deleted Files Detected
The following **${deletedFiles.length}** file(s) have been deleted:
${deletedFiles.map(file => `- \`${file}\``).join('\n')}
*Please ensure this was intentional and all references have been removed.*`;
    warn(message);
}

const MR_MIN_TITLE = 10;
const MR_MIN_DESCRIPTION = 20;

function reviewMrMetadata() {
    if (mr.title.length < MR_MIN_TITLE) {
        warn("📝 **Short Title:** The Merge Request title seems too short. Please add more details.");
    }
    if (mr.title.match(/^(WIP|DRAFT)/i)) {
        fail("🚫 **Work in Progress:** This MR is marked as 'WIP' or 'Draft' and cannot be merged yet.");
    }
    if (!mr.description || mr.description.length < MR_MIN_DESCRIPTION) {
        warn("📄 **Missing Description:** Please provide a more detailed description for this Merge Request.");
    }
}

async function reviewFileChanges() {
    const hasLibChanges = hasChangesIn('lib/', allChangedFiles);
    const hasChangelogChanges = modifiedFiles.includes('CHANGELOG.md');

    if (hasLibChanges && !hasChangelogChanges) {
        await generateChangelogSuggestion();
    }

    const pubspecYamlModified = modifiedFiles.includes('pubspec.yaml');
    const pubspecLockModified = modifiedFiles.includes('pubspec.lock');

    if (pubspecYamlModified && !pubspecLockModified) {
        fail("🔒 **`pubspec.lock` is out of sync:** Please run `flutter pub get` and commit the `pubspec.lock` file.");
    }

    if (allChangedFiles.length > 20) {
        fail("🚨 **Too Many Changes:** This MR modifies more than 20 files. Please consider breaking it down into smaller MRs.");
    }
}

async function generateChangelogSuggestion() {
    const dartFiles = allChangedFiles.filter(file => file.endsWith('.dart') && !isGeneratedFile(file));
    let fullDiff = '';

    for (const file of dartFiles) {
        const diffObj = await git.diffForFile(file);
        if (diffObj && diffObj.diff) {
            fullDiff += `\n// File: ${file}\n${diffObj.diff}\n`;
        }
    }

    if (!fullDiff) return;

    const prompt = `
        You are a release manager writing a changelog entry for a Flutter project.
        Based on the following code diff, generate a concise, user-facing changelog entry as a single bullet point.
        Focus on the "what" and "why", not the "how".

        Here is the code diff:
        \`\`\`diff
        ${fullDiff}
        \`\`\`
    `;

    const suggestion = await callGemini(prompt, 'Changelog Suggestion');

    if (suggestion) {
        const message = `
### 📜 Suggested CHANGELOG Entry
I noticed changes in the \`lib/\` folder, but \`CHANGELOG.md\` wasn't updated. Here's a suggestion:

\`\`\`markdown
${suggestion.trim()}
\`\`\`

*Please review this suggestion, edit if necessary, and add it to \`CHANGELOG.md\`.*
        `;
        markdown(message);
    } else {
        warn("📜 **CHANGELOG Missing?** Changes in `lib/` were detected, but `CHANGELOG.md` was not updated.");
    }
}


async function reviewCodeContent() {
    const dartFiles = allChangedFiles.filter(file => file.endsWith('.dart') && !isGeneratedFile(file));
    for (const file of dartFiles) {
        const diff = await git.structuredDiffForFile(file);
        if (!diff) continue;
        diff.chunks.forEach(chunk => {
            chunk.changes.forEach(change => {
                if (change.type === 'add') {
                    if (change.content.includes('print(')) {
                        warn(`🚫 **Avoid \`print()\`:** A \`print()\` statement was found in \`${file}\`. Please use a dedicated logger.`, file, change.ln);
                    }
                    if (change.content.match(/\/\/\s?TODO/i)) {
                        message(`📝 **TODO Found:** A TODO was found in \`${file}\`. Please ensure it's addressed.`, file, change.ln);
                    }
                }
            });
        });
    }
}

function formatDiffWithLineNumbers(structuredDiff) {
    if (!structuredDiff || !structuredDiff.chunks) return "";
    let result = "";
    structuredDiff.chunks.forEach(chunk => {
        result += `\n--- Chunk @@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@\n`;
        chunk.changes.forEach(change => {
            const lineNum = change.ln || change.ln2 || change.ln1 || "";
            const prefix = change.type === "add" ? "+" : (change.type === "del" ? "-" : " ");
            result += `L${lineNum}: ${prefix} ${change.content}\n`;
        });
    });
    return result;
}

const MR_MAX_FILE_DIFF = 8000;
async function reviewPerFileWithGeminiAI() {
    if (!GEMINI_API_KEY) {
        console.log("GEMINI_API_KEY not found. Skipping AI file review.");
        return;
    }
    const filesToReview = allChangedFiles.filter(file => file.endsWith('.dart') && !isGeneratedFile(file));
    if (filesToReview.length === 0) return;

    message("🤖 **AI Code Review in Progress...** Analyzing changed files. Please wait a moment.");
    let allAiFeedback = [];

    for (const file of filesToReview) {
        const structuredDiff = await git.structuredDiffForFile(file);
        if (!structuredDiff) continue;

        const formattedDiff = formatDiffWithLineNumbers(structuredDiff);
        if (formattedDiff.length > MR_MAX_FILE_DIFF) {
            console.log(`Skipping AI review for ${file} (diff too large).`);
            continue;
        }

        const prompt = `
You are an expert Flutter/Dart code reviewer. Analyze the diff for \`${file}\`.

Write code review comments terse and actionable. One line per finding. Location, problem, fix. No throat-clearing.

## Rules

**Format:**
\`${file}:L<line>: <severity> <problem>. <fix>.\` (One line per finding)

**Severity prefixes:**
- \`🔴 bug:\` — broken behavior, will cause incident
- \`🟡 risk:\` — works but fragile (race, missing null check, swallowed error)
- \`🔵 nit:\` — style, naming, micro-optim. Author can ignore
- \`❓ q:\` — genuine question, not a suggestion

**Drop:**
- "I noticed that...", "It seems like...", "You might want to consider..."
- "This is just a suggestion but..." — use \`nit:\` instead
- "Great work!", "Looks good overall but..." — say it once at the top, not per comment
- Restating what the line does — the reviewer can read the diff
- Hedging ("perhaps", "maybe", "I think") — if unsure use \`q:\`

**Keep:**
- Exact line numbers (use the line numbers prefixed with "L" in the diff)
- Exact symbol/function/variable names in backticks
- Concrete fix, not "consider refactoring this"
- The *why* if the fix isn't obvious from the problem statement

**Auto-clarity:**
- Drop terse mode for CVE-class security findings, major architectural disagreements, and complex context where the author needs the *why*. Resume terse for the rest.

**Output:**
Provide a bulleted list of findings. If there are no bug, risk, or nit issues, strictly output: "✅ No significant issues found."

Diff for \`${file}\` (with line numbers prefixed):
\`\`\`diff
${formattedDiff}
\`\`\`
`;

        const feedback = await callGemini(prompt, `File Review: ${file}`);
        console.log(`[AI Review] Raw feedback for ${file}:\n${feedback}`);

        if (feedback && !feedback.includes("No significant issues found.")) {
            const lines = feedback.split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                let match = trimmed.match(/^(?:-\s*|\d+\.\s*)?([^:]+):L(\d+):\s*(.*)$/);
                let detectedFile = file;
                let lineNum = null;
                let commentText = "";

                if (match) {
                    detectedFile = match[1].trim();
                    lineNum = parseInt(match[2], 10);
                    commentText = match[3].trim();
                } else {
                    match = trimmed.match(/^(?:-\s*|\d+\.\s*)?L(\d+):\s*(.*)$/);
                    if (match) {
                        lineNum = parseInt(match[1], 10);
                        commentText = match[2].trim();
                    }
                }

                if (lineNum && commentText) {
                    console.log(`[AI Review] Posting inline: ${detectedFile}:L${lineNum}: ${commentText}`);
                    const lowerText = commentText.toLowerCase();
                    if (lowerText.includes("🔴 bug") || lowerText.includes("🛑 p0") || lowerText.includes("⚠️ p1")) {
                        fail(commentText, detectedFile, lineNum);
                    } else if (lowerText.includes("🟡 risk") || lowerText.includes("♻️ p2")) {
                        warn(commentText, detectedFile, lineNum);
                    } else {
                        message(commentText, detectedFile, lineNum);
                    }
                } else {
                    console.log(`[AI Review] Fallback to general comment: ${trimmed}`);
                    allAiFeedback.push(`- **${detectedFile}**: ${commentText || trimmed}`);
                }
            }
        } else if (!feedback) {
            allAiFeedback.push(`### ⚠️ Review for \`${file}\`\n\nCould not get AI feedback for this file.`);
        }
    }

    if (allAiFeedback.length > 0) {
        markdown("## 🤖 AI Assistant Review\n\n### General Comments\n" + allAiFeedback.join("\n"));
    }
}

/**
 * Posts a summary of the total tokens used by the Gemini API to the MR.
 */

function reportTotalTokenUsage() {
    if (tokenTracker.calls > 0) {
        const breakdown = tokenTracker.requests
            .map(req => `- ${req.purpose}: **${req.tokenCount}** tokens`)
            .join('\n');

        const totalMessage = `
            ---
            ### 🤖 AI Token Usage Summary
            - **Total API Calls:** ${tokenTracker.calls}
            - **Total Tokens Consumed:** **${tokenTracker.total}**

            **Breakdown:**
            ${breakdown}
                    `;
        message(totalMessage);
    }
}

// =============================================================================
// Run the Review
// =============================================================================
runCodeReview();