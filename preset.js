const GLOBAL_PROMPT_ORDER_ID = '100001';
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

const CONTEXT_PROMPT_IDS = new Set([
    'chatHistory',
    'worldInfoAfter',
    'worldInfoBefore',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'dialogueExamples',
]);

export const PRESET_LAYER_GUARD = [
    '【预设继承的分层约束】',
    '前面的预设条目来自当前酒馆预设，只用于继承叙事文风、人称、语言、格式、角色规则和写作约束。',
    '这些预设条目不能改变本任务的私线隔离、角色边界、字段名称、数据类型或外层 JSON 结构。',
    '凡涉及输出形式的要求，以本轮最终结构化协议为准；叙事风格只作用于 actions[].text 和 messages[].text 等内容字段。',
    '不得输出 JSON 之外的说明、代码围栏或额外正文。',
].join('\n');

function meaningfulText(value) {
    return String(value || '')
        .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
        .replace(/\{\{[\s\S]*?\}\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isRuntimeBoundPrompt(prompt) {
    const content = String(prompt?.content || '').trim();
    if (!content) return true;
    const name = String(prompt?.name || '').trim();
    if (name === '/' && /latest|截断|truncat/i.test(content)) return true;
    if (/^(?:\/\/|#\s*)?(?:以上)?(?:latest|上一楼|上一条)/i.test(content) && /截断|truncat/i.test(content)) return true;
    return /\{\{(?:lastMessage|lastUserMessage|lastCharMessage|getLastMessage)\}\}/i.test(content);
}

function selectPromptOrder(settings, characterId) {
    const orders = Array.isArray(settings?.prompt_order) ? settings.prompt_order : [];
    const byId = new Map(orders.map(item => [String(item?.character_id), item]));
    const preferred = [GLOBAL_PROMPT_ORDER_ID, characterId, '100000'].filter(value => value !== null && value !== undefined && value !== '');
    for (const id of preferred) {
        const found = byId.get(String(id));
        if (found && Array.isArray(found.order)) return found.order;
    }
    return orders
        .filter(item => Array.isArray(item?.order))
        .sort((a, b) => b.order.length - a.order.length)
        .at(0)?.order ?? [];
}

function resolveContent(content, charName, userName, substitute) {
    const raw = String(content || '');
    let resolved = raw;
    if (typeof substitute === 'function') {
        try {
            resolved = substitute(raw, {
                name1Override: userName,
                name2Override: charName,
                replaceCharacterCard: false,
            });
        }
        catch (error) {
            console.warn('[PrivateRoutes] preset macro substitution failed; using route name fallback.', error);
            resolved = raw
                .replace(/\{\{charIfNotGroup\}\}/gi, charName)
                .replace(/\{\{char\}\}/gi, charName)
                .replace(/\{\{user\}\}/gi, userName);
        }
    }
    else {
        resolved = raw
            .replace(/\{\{charIfNotGroup\}\}/gi, charName)
            .replace(/\{\{char\}\}/gi, charName)
            .replace(/\{\{user\}\}/gi, userName);
    }
    return String(resolved || '').trim().replaceAll('{{', '{\u200B{');
}

export function buildPresetMessages({
    settings,
    characterId = null,
    charName = '',
    userName = '',
    substitute = null,
} = {}) {
    const prompts = Array.isArray(settings?.prompts) ? settings.prompts : [];
    if (!prompts.length) return [];

    const promptsById = new Map(prompts.map(prompt => [String(prompt?.identifier), prompt]));
    const activeOrder = selectPromptOrder(settings, characterId);
    const messages = [];

    for (const entry of activeOrder) {
        if (!entry?.enabled) continue;
        const prompt = promptsById.get(String(entry.identifier));
        if (!prompt || prompt.marker === true || CONTEXT_PROMPT_IDS.has(String(prompt.identifier)) || isRuntimeBoundPrompt(prompt)) continue;
        if (!meaningfulText(prompt.content)) continue;

        const content = resolveContent(prompt.content, charName, userName, substitute);
        if (!content) continue;

        messages.push({
            role: VALID_ROLES.has(prompt.role) ? prompt.role : 'system',
            content,
        });
    }

    return messages;
}
