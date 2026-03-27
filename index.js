/*
 * Chain Thinking - SillyTavern Extension
 *
 * Automates a multi-step generation pipeline:
 *   Step 1 (Think):   Runs pre-analysis with think-phase rules → produces reasoning
 *   Step 2 (Write):   Normal generation with reasoning injected + write-phase rules
 *   Step 3 (Judge):   Evaluates response against judge-phase rules (optional)
 *   Step 4 (Rewrite): Fixes violations if judge pass rate < threshold (conditional)
 */

import {
    extension_settings,
    saveSettingsDebounced,
    renderExtensionTemplateAsync,
    getContext,
} from '../../../extensions.js';

import {
    generateQuietPrompt,
    saveChatDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

// ============================================================
//  CONSTANTS
// ============================================================

const MODULE_NAME = 'Extension-ChainThinking';
const extensionFolder = `scripts/extensions/third-party/${MODULE_NAME}`;

// ============================================================
//  DEFAULT SETTINGS
// ============================================================

const DEFAULT_THINK_PROMPT = [
    '[OOC: Pause the roleplay. Answer in 7 lines:',
    '1. What actually happened in the scene?',
    '2. What were the user\'s instructions? (Copy-paste the dialogue. Identify each sentence, question, or fragment separately. One sentence/fragment = one numbered item. For each item, state what it instructs or communicates. Do not combine. Do not interpret. Do not decide what they "really mean.")',
    '3. What logically follows from that?',
    '4. What do the characters realistically know and say from their actual lives?',
    '5. Are you overriding user\'s instructions? (Your judgment, Your discomfort, Your "helpfulness" substituting for those instructions)',
    '6. Are you pattern-matching? (What keyword triggered autopilot instead of thought?)',
    '7. What are you assuming that wasn\'t explicitly stated?]',
    '[OOC: Do NOT continue the roleplay.]',
].join('\n');

const DEFAULT_JUDGE_PROMPT = [
    '[OOC: You are a quality judge. Evaluate the following response against the provided rules.',
    '',
    'For each rule group, check every sub-rule and report:',
    '- result: "PASS" or "FAIL"',
    '- quote: exact text that violates (empty string if PASS)',
    '- reason: why it violates (empty string if PASS)',
    '- fix: suggested correction (empty string if PASS)',
    '',
    'Respond ONLY with valid JSON in this exact format:',
    '{"results": [{"rule": "Rule Name", "result": "PASS", "quote": "", "reason": "", "fix": ""}], "passRate": 0.85}',
    '',
    'passRate is the fraction of rules that passed (0.0 to 1.0).',
    'Do NOT include any text outside the JSON.]',
].join('\n');

const DEFAULT_REWRITE_PROMPT = [
    '[OOC: Rewrite the response to fix the listed violations.',
    '- Only change what needs to change',
    '- Preserve the original style, voice, and content',
    '- Do not add new content beyond what fixes require',
    '- Do not reference these instructions in the rewrite',
    '- Output ONLY the rewritten response, nothing else.]',
].join('\n');

const defaultSettings = {
    enabled: true,
    showDebug: false,
    think: {
        enabled: true,
        prompt: DEFAULT_THINK_PROMPT,
    },
    judge: {
        enabled: false,
        prompt: DEFAULT_JUDGE_PROMPT,
        passThreshold: 80,
    },
    rewrite: {
        prompt: DEFAULT_REWRITE_PROMPT,
    },
    rules: [],
};

// ============================================================
//  STATE
// ============================================================

let pendingJudge = false;

// ============================================================
//  SETTINGS HELPERS
// ============================================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    return extension_settings[MODULE_NAME];
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================================
//  RULE HELPERS
// ============================================================

function getRulesForPhase(phase) {
    return getSettings().rules.filter(r => r.enabled && r.phases[phase]);
}

function buildRulesText(rules) {
    return rules.map(r => r.content).join('\n\n');
}

function findRuleById(id) {
    return getSettings().rules.find(r => r.id === id);
}

// ============================================================
//  PROMPT BUILDERS
// ============================================================

function buildThinkPrompt() {
    const settings = getSettings();
    const parts = [];

    const thinkRules = getRulesForPhase('think');
    if (thinkRules.length > 0) {
        parts.push(buildRulesText(thinkRules));
    }

    parts.push(settings.think.prompt);
    return parts.join('\n\n');
}

function buildJudgePrompt(responseText) {
    const settings = getSettings();
    const parts = [];

    const judgeRules = getRulesForPhase('judge');
    if (judgeRules.length > 0) {
        parts.push('Rules to judge against:\n\n' + buildRulesText(judgeRules));
    }

    parts.push('Response to judge:\n\n' + responseText);
    parts.push(settings.judge.prompt);
    return parts.join('\n\n');
}

function buildRewritePrompt(responseText, feedback) {
    const settings = getSettings();
    const parts = [];

    const writeRules = getRulesForPhase('write');
    if (writeRules.length > 0) {
        parts.push('Rules to follow:\n\n' + buildRulesText(writeRules));
    }

    parts.push('Original response:\n\n' + responseText);
    parts.push('Violations found:\n\n' + feedback);
    parts.push(settings.rewrite.prompt);
    return parts.join('\n\n');
}

// ============================================================
//  STEP 1 & 2: GENERATE INTERCEPTOR (Think + Rule Injection)
// ============================================================

globalThis.ChainThinking_interceptGeneration = async function (chat, _contextSize, _abort, type) {
    const settings = getSettings();

    // Skip if disabled or if this is a quiet/background prompt (avoid recursion)
    if (!settings.enabled) return;
    if (type === 'quiet') return;

    // --- Step 1: Think ---
    if (settings.think.enabled) {
        try {
            if (settings.showDebug) {
                toastr.info('Running think step...', 'Chain Thinking', { timeOut: 10000 });
            }

            const thinkPrompt = buildThinkPrompt();
            const thinkOutput = await generateQuietPrompt(thinkPrompt, false, false);

            if (thinkOutput && thinkOutput.trim()) {
                // Inject the thinking output as system context for the real generation
                chat.push({
                    role: 'system',
                    content: [
                        '[Chain Thinking Pre-Analysis]',
                        thinkOutput,
                        '[Use the analysis above to inform your response. Do not reference or repeat this analysis directly.]',
                    ].join('\n'),
                });

                if (settings.showDebug) {
                    toastr.success('Think step complete', 'Chain Thinking', { timeOut: 3000 });
                    console.log('[Chain Thinking] Think output:', thinkOutput);
                }
            }
        } catch (err) {
            console.error('[Chain Thinking] Think step failed:', err);
            toastr.error('Think step failed: ' + err.message, 'Chain Thinking');
        }
    }

    // --- Step 2: Inject write-phase rules ---
    const writeRules = getRulesForPhase('write');
    if (writeRules.length > 0) {
        chat.push({
            role: 'system',
            content: buildRulesText(writeRules),
        });
    }

    // Flag for post-generation judge step
    if (settings.judge.enabled) {
        pendingJudge = true;
    }
};

// ============================================================
//  STEPS 3 & 4: JUDGE + CONDITIONAL REWRITE
// ============================================================

async function handlePostGeneration(messageIndex) {
    if (!pendingJudge) return;
    pendingJudge = false;

    const settings = getSettings();
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) return;

    // Find the last assistant message
    const idx = typeof messageIndex === 'number' ? messageIndex : chat.length - 1;
    const message = chat[idx];
    if (!message || message.is_user) return;

    const responseText = message.mes;
    if (!responseText || !responseText.trim()) return;

    try {
        // --- Step 3: Judge ---
        if (settings.showDebug) {
            toastr.info('Running judge step...', 'Chain Thinking', { timeOut: 10000 });
        }

        const judgePrompt = buildJudgePrompt(responseText);
        const judgeOutput = await generateQuietPrompt(judgePrompt, false, true);

        if (!judgeOutput) {
            console.warn('[Chain Thinking] Judge returned empty output');
            return;
        }

        if (settings.showDebug) {
            console.log('[Chain Thinking] Judge output:', judgeOutput);
        }

        // Parse JSON from judge output
        const jsonMatch = judgeOutput.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('[Chain Thinking] No JSON found in judge output');
            if (settings.showDebug) {
                toastr.warning('Judge output was not valid JSON — skipping rewrite', 'Chain Thinking');
            }
            return;
        }

        let judgeResult;
        try {
            judgeResult = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            console.warn('[Chain Thinking] JSON parse error:', parseErr.message);
            if (settings.showDebug) {
                toastr.warning('Judge JSON parse failed — skipping rewrite', 'Chain Thinking');
            }
            return;
        }

        // Calculate pass rate (handle both 0-1 and 0-100 formats)
        let passRate;
        if (typeof judgeResult.passRate === 'number') {
            passRate = judgeResult.passRate <= 1.0 ? judgeResult.passRate * 100 : judgeResult.passRate;
        } else if (Array.isArray(judgeResult.results) && judgeResult.results.length > 0) {
            const passed = judgeResult.results.filter(r => r.result === 'PASS').length;
            passRate = (passed / judgeResult.results.length) * 100;
        } else {
            console.warn('[Chain Thinking] Cannot determine pass rate from judge output');
            return;
        }

        if (settings.showDebug) {
            toastr.info(
                `Pass rate: ${passRate.toFixed(0)}% (threshold: ${settings.judge.passThreshold}%)`,
                'Chain Thinking',
                { timeOut: 5000 },
            );
        }

        // --- Step 4: Rewrite if below threshold ---
        if (passRate >= settings.judge.passThreshold) {
            if (settings.showDebug) {
                toastr.success(`Passed (${passRate.toFixed(0)}%) — no rewrite needed`, 'Chain Thinking');
            }
            return;
        }

        if (settings.showDebug) {
            toastr.info('Below threshold — rewriting...', 'Chain Thinking', { timeOut: 10000 });
        }

        const failures = Array.isArray(judgeResult.results)
            ? judgeResult.results
                .filter(r => r.result === 'FAIL')
                .map(r => {
                    let line = `- [${r.rule}]: ${r.reason}`;
                    if (r.quote) line += ` ("${r.quote}")`;
                    if (r.fix) line += ` -> Fix: ${r.fix}`;
                    return line;
                })
                .join('\n')
            : 'Multiple rule violations detected.';

        const rewritePrompt = buildRewritePrompt(responseText, failures);
        const rewritten = await generateQuietPrompt(rewritePrompt, false, false);

        if (rewritten && rewritten.trim()) {
            // Update message data
            message.mes = rewritten;
            saveChatDebounced();

            // Update the visible message in the DOM
            const mesElement = $(`#chat .mes[mesid="${idx}"] .mes_text`);
            if (mesElement.length) {
                // Try to use ST's message formatting for proper markdown/HTML rendering
                try {
                    const scriptModule = await import('../../../../script.js');
                    if (typeof scriptModule.messageFormatting === 'function') {
                        mesElement.html(
                            scriptModule.messageFormatting(rewritten, context.name2, false, false, idx),
                        );
                    } else {
                        mesElement.html(rewritten.replace(/\n/g, '<br>'));
                    }
                } catch {
                    mesElement.html(rewritten.replace(/\n/g, '<br>'));
                }
            }

            if (settings.showDebug) {
                toastr.success('Response rewritten', 'Chain Thinking');
                console.log('[Chain Thinking] Rewritten response:', rewritten);
            }
        }
    } catch (err) {
        console.error('[Chain Thinking] Judge/Rewrite step failed:', err);
        toastr.error('Judge step failed: ' + err.message, 'Chain Thinking');
    }
}

// ============================================================
//  UI: RULE CARD RENDERING
// ============================================================

function renderRuleCard(rule) {
    return `
        <div class="ct-rule" data-rule-id="${rule.id}">
            <div class="ct-rule-header">
                <label class="checkbox_label" title="Enable/disable this rule">
                    <input type="checkbox" class="ct-rule-enabled" ${rule.enabled ? 'checked' : ''} />
                </label>
                <input type="text" class="ct-rule-name text_pole" value="${escapeHtml(rule.name)}" placeholder="Rule name" />
                <div class="ct-rule-phases">
                    <label class="checkbox_label" title="Include in Think step">
                        <input type="checkbox" class="ct-rule-phase" data-phase="think" ${rule.phases.think ? 'checked' : ''} />
                        <span>T</span>
                    </label>
                    <label class="checkbox_label" title="Include in Write step">
                        <input type="checkbox" class="ct-rule-phase" data-phase="write" ${rule.phases.write ? 'checked' : ''} />
                        <span>W</span>
                    </label>
                    <label class="checkbox_label" title="Include in Judge step">
                        <input type="checkbox" class="ct-rule-phase" data-phase="judge" ${rule.phases.judge ? 'checked' : ''} />
                        <span>J</span>
                    </label>
                </div>
                <div class="menu_button ct-rule-expand" title="Expand/collapse">
                    <i class="fa-solid fa-chevron-down"></i>
                </div>
                <div class="menu_button ct-rule-delete" title="Delete rule">
                    <i class="fa-solid fa-trash"></i>
                </div>
            </div>
            <div class="ct-rule-body" style="display: none;">
                <textarea class="ct-rule-content text_pole" rows="8" placeholder="Paste rule content here...">${escapeHtml(rule.content)}</textarea>
            </div>
        </div>`;
}

function renderRulesList() {
    const settings = getSettings();
    const container = $('#ct_rules_list');
    container.empty();

    if (settings.rules.length === 0) {
        container.append('<div class="ct-no-rules">No rules configured. Click "Add Rule" to start.</div>');
        return;
    }

    for (const rule of settings.rules) {
        container.append(renderRuleCard(rule));
    }
}

// ============================================================
//  UI: EVENT BINDING
// ============================================================

function bindRuleEvents() {
    const container = $('#ct_rules_list');

    // Rule enable/disable
    container.off('change', '.ct-rule-enabled').on('change', '.ct-rule-enabled', function () {
        const id = $(this).closest('.ct-rule').attr('data-rule-id');
        const rule = findRuleById(id);
        if (rule) {
            rule.enabled = !!$(this).prop('checked');
            saveSettingsDebounced();
        }
    });

    // Rule name
    container.off('input', '.ct-rule-name').on('input', '.ct-rule-name', function () {
        const id = $(this).closest('.ct-rule').attr('data-rule-id');
        const rule = findRuleById(id);
        if (rule) {
            rule.name = $(this).val();
            saveSettingsDebounced();
        }
    });

    // Phase toggles
    container.off('change', '.ct-rule-phase').on('change', '.ct-rule-phase', function () {
        const id = $(this).closest('.ct-rule').attr('data-rule-id');
        const phase = $(this).attr('data-phase');
        const rule = findRuleById(id);
        if (rule && phase) {
            rule.phases[phase] = !!$(this).prop('checked');
            saveSettingsDebounced();
        }
    });

    // Rule content
    container.off('input', '.ct-rule-content').on('input', '.ct-rule-content', function () {
        const id = $(this).closest('.ct-rule').attr('data-rule-id');
        const rule = findRuleById(id);
        if (rule) {
            rule.content = $(this).val();
            saveSettingsDebounced();
        }
    });

    // Expand/collapse
    container.off('click', '.ct-rule-expand').on('click', '.ct-rule-expand', function () {
        const body = $(this).closest('.ct-rule').find('.ct-rule-body');
        body.slideToggle(200);
        $(this).find('i').toggleClass('fa-chevron-down fa-chevron-up');
    });

    // Delete
    container.off('click', '.ct-rule-delete').on('click', '.ct-rule-delete', function () {
        const id = $(this).closest('.ct-rule').attr('data-rule-id');
        const settings = getSettings();
        settings.rules = settings.rules.filter(r => r.id !== id);
        saveSettingsDebounced();
        renderRulesList();
    });
}

// ============================================================
//  UI: SETTINGS PANEL INIT
// ============================================================

async function initUI() {
    const html = await renderExtensionTemplateAsync(extensionFolder, 'template');
    $('#extensions_settings').append(html);

    const settings = getSettings();

    // --- Master toggle ---
    $('#ct_enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            settings.enabled = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    // --- Think step ---
    $('#ct_think_enabled')
        .prop('checked', settings.think.enabled)
        .on('change', function () {
            settings.think.enabled = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#ct_think_prompt')
        .val(settings.think.prompt)
        .on('input', function () {
            settings.think.prompt = $(this).val();
            saveSettingsDebounced();
        });

    // --- Judge step ---
    $('#ct_judge_enabled')
        .prop('checked', settings.judge.enabled)
        .on('change', function () {
            settings.judge.enabled = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#ct_judge_threshold')
        .val(settings.judge.passThreshold)
        .on('input', function () {
            const val = parseInt($(this).val(), 10);
            settings.judge.passThreshold = val;
            $('#ct_threshold_display').text(val);
            saveSettingsDebounced();
        });
    $('#ct_threshold_display').text(settings.judge.passThreshold);

    $('#ct_judge_prompt')
        .val(settings.judge.prompt)
        .on('input', function () {
            settings.judge.prompt = $(this).val();
            saveSettingsDebounced();
        });

    // --- Rewrite prompt ---
    $('#ct_rewrite_prompt')
        .val(settings.rewrite.prompt)
        .on('input', function () {
            settings.rewrite.prompt = $(this).val();
            saveSettingsDebounced();
        });

    // --- Debug toggle ---
    $('#ct_show_debug')
        .prop('checked', settings.showDebug)
        .on('change', function () {
            settings.showDebug = !!$(this).prop('checked');
            saveSettingsDebounced();
        });

    // --- Add rule button ---
    $('#ct_add_rule').on('click', function () {
        const settings = getSettings();
        settings.rules.push({
            id: generateId(),
            name: 'New Rule',
            content: '',
            enabled: true,
            phases: { think: false, write: true, judge: true },
        });
        saveSettingsDebounced();
        renderRulesList();
    });

    // Initial render
    renderRulesList();
    bindRuleEvents();
}

// ============================================================
//  INITIALIZATION
// ============================================================

jQuery(async () => {
    await initUI();

    // Register post-generation event handler for judge step
    if (eventSource && event_types) {
        // MESSAGE_RECEIVED fires after the assistant message is added to chat
        const eventName = event_types.MESSAGE_RECEIVED;
        if (eventName) {
            eventSource.on(eventName, handlePostGeneration);
            console.log(`[Chain Thinking] Post-generation handler registered on "${eventName}"`);
        } else {
            console.warn('[Chain Thinking] event_types.MESSAGE_RECEIVED is not defined');
        }
    } else {
        console.warn('[Chain Thinking] eventSource or event_types not available — judge step will not work');
    }

    console.log('[Chain Thinking] Extension loaded successfully');
});
