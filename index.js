import { shouldSendOnEnter } from '/scripts/RossAscends-mods.js';
import { PLAYER, STATE_KEY, TURN_KEY, playTurn, readStory, storyClock } from './engine.js';

const SETTINGS_KEY = 'privateRoutes';
const INPUT_KEY = 'privateRoutesInput';
const SEND_SELECTOR = '#send_but';
const STOP_SELECTOR = '#mes_stop';
const NATIVE_GENERATION = '#option_regenerate, #option_continue, #mes_continue, #mes_impersonate, .group_member [data-action="speak"]';
const getContext = () => globalThis.SillyTavern.getContext();
let ui;
let running;
let status = '';

function current(context = getContext()) {
    const group = context.groups.find(item => String(item.id) === String(context.groupId));
    if (!group || !context.chatId) return {};
    const groups = context.extensionSettings[SETTINGS_KEY] ??= {};
    const config = groups[String(group.id)] ??= { enabled: false, main: '' };
    const cards = group.members.map(id => context.characters.find(card => card.avatar === id)).filter(Boolean);
    return { group, config, cards, chatId: context.chatId };
}

function sceneLabel({ minute, date }, cards, username) {
    if (!date) return storyClock(minute) + ' · 线上';
    const partner = date === PLAYER ? username : cards.find(card => card.avatar === date)?.name ?? '原群成员';
    return storyClock(minute) + ' · 与 ' + partner + ' 线下约会';
}

function disableNativeAutoMode() {
    const auto = document.querySelector('#rm_group_automode');
    if (!auto?.checked) return;
    auto.checked = false;
    auto.dispatchEvent(new Event('input', { bubbles: true }));
}

function render() {
    if (!ui) return;
    const context = getContext();
    const { group, cards, config, chatId } = current(context);
    const activeTurn = config?.enabled && running?.chatId === chatId && running?.groupId === group?.id;
    if (activeTurn) {
        ui.sendForm.dataset.privateRoutesState = running.saving ? 'saving' : 'generating';
    } else {
        delete ui.sendForm.dataset.privateRoutesState;
    }
    ui.root.hidden = !group;
    if (!group) return;
    ui.enabled.checked = !!config.enabled;
    ui.enabled.disabled = Boolean(running);
    ui.main.hidden = !config.enabled;
    ui.main.disabled = Boolean(running);
    ui.status.hidden = !config.enabled;
    if (!config.enabled) return;
    disableNativeAutoMode();
    ui.main.replaceChildren(new Option('选择主卡', ''));
    for (const card of cards) ui.main.append(new Option(card.name, card.avatar));
    ui.main.value = cards.some(card => card.avatar === config.main) ? config.main : '';
    ui.status.textContent = status || (ui.main.value
        ? sceneLabel(readStory(context.chat, config.main, context.chatMetadata), cards, context.name1)
        : '选择一张主卡后发送消息');
}

function roleSheet(card, otherName) {
    const data = card.data ?? {};
    const localize = value => value.replace(/\{\{(char|user)\}\}/gi, (_, role) => role.toLowerCase() === 'char' ? card.name : otherName);
    const sheet = { name: card.name };
    for (const [key, legacy] of [
        ['description', 'description'], ['personality', 'personality'], ['scenario', 'scenario'],
        ['mes_example', 'mes_example'], ['system_prompt', 'system_prompt'], ['post_history_instructions', 'post_history_instructions'],
        ['first_mes', 'first_mes'],
    ]) {
        const value = data[key] || card[legacy];
        if (typeof value === 'string' && value.trim()) sheet[key] = localize(value);
    }
    return {
        name: card.name,
        id: card.avatar,
        sheet,
        showStatusBar: (Array.isArray(data.extensions?.regex_scripts)
            && data.extensions.regex_scripts.some(rule => rule?.scriptName === '团子状态栏' && !rule.disabled))
            || (typeof data.system_prompt === 'string' && data.system_prompt.includes('aff_luye')),
    };
}

function markdownSafe(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanGeneratedText(value) {
    return String(value)
        .replace(/<state>[\s\S]*?<\/state>/gi, '')
        .replace(/【团子状态】/g, '')
        .trim();
}

function textOfTurn(turn, main, player, sides, includeStatus = true) {
    const sections = [];
    for (const route of [{ id: PLAYER, name: player.name }, ...sides]) {
        const events = turn.events.filter(event => event.route === route.id && ['main', 'side'].includes(event.kind))
            .sort((a, b) => a.minute - b.minute);
        const lines = events.map(event => {
            const speaker = event.kind === 'main' ? main.name : route.name;
            const queued = event.pending ? ' · 约会期间来信' : '';
            return '**' + markdownSafe(speaker) + '** · ' + storyClock(event.minute) + queued + '\n\n' + markdownSafe(cleanGeneratedText(event.text));
        });
        const title = '### @' + markdownSafe(route.id === PLAYER ? '你' : route.name);
        const mainActed = events.some(event => event.kind === 'main');
        const noAction = '主卡本轮无行为';
        if (!mainActed) lines.unshift(noAction);
        sections.push(title + '\n\n' + lines.join('\n\n'));
    }
    const body = sections.join('\n\n---\n\n');
    return includeStatus && main.showStatusBar ? body + '\n\n【团子状态】' : body;
}

function stateLabel(state, routeId, routes) {
    return routes.find(route => route.id === routeId)?.name ?? '无';
}

function syncStateVariables(context, state, main, player, sides) {
    const local = context.variables?.local;
    if (!local) return;
    const routes = [{ id: PLAYER, name: player.name }, ...sides.map(card => ({ id: card.id, name: card.name }))];
    const affinity = state?.affinity ?? {};
    const value = id => String(Number.isFinite(Number(affinity[id])) ? affinity[id] : 0);
    local.set('aff_me', value(PLAYER));
    local.set('aff_user', value(PLAYER));
    const luye = routes.find(route => route.name === '路野' || route.name === '周野');
    const lushi = routes.find(route => route.name === '陆时');
    if (luye) {
        local.set('aff_luye', value(luye.id));
        local.set('aff_zhouye', value(luye.id));
    }
    if (lushi) local.set('aff_lushi', value(lushi.id));
    local.set('obsession_name', stateLabel(state, state?.obsession, routes));
}

function renderLivePreview(context, main, player, sides, turn, state) {
    const chatElement = document.querySelector('#chat');
    if (!chatElement) return;
    syncStateVariables(context, state, main, player, sides);
    let preview = document.querySelector('#private-routes-live');
    if (!preview) {
        preview = document.createElement('div');
        preview.id = 'private-routes-live';
        preview.className = 'mes private-routes-live';
        chatElement.append(preview);
    }
    const body = textOfTurn(turn, main, player, sides);
    preview.innerHTML = '<div class="private-routes-live-label">正在生成多线回复…</div><div class="private-routes-live-content"></div>';
    const content = preview.querySelector('.private-routes-live-content');
    content.innerHTML = context.messageFormatting(body, main.name, false, false, -1, {}, false);
}

function removeLivePreview() {
    document.querySelector('#private-routes-live')?.remove();
}

function showError(message) {
    status = message;
    render();
    globalThis.toastr?.warning(message, '多线群聊');
}

function cancel() {
    if (!running || running.saving || running.controller.signal.aborted) return;
    running.controller.abort();
    getContext().stopGeneration();
}

async function send() {
    if (running) return;
    const context = getContext();
    const { group, config, cards, chatId } = current(context);
    if (!config?.enabled) return;
    const textarea = document.querySelector('#send_textarea');
    const input = textarea?.value.trim();
    if (!input) return;
    const mainCard = cards.find(card => card.avatar === config.main);
    if (!mainCard) return showError('请先选择当前群聊的主卡。');
    if (context.onlineStatus === 'no_connection') return showError('请先连接酒馆的模型。');
    if (document.querySelector('#file_form_input')?.files?.length || document.querySelector('#embed_file_input')?.files?.length) {
        return showError('多线群聊目前支持文本。请先移除附件。');
    }
    const player = { name: context.name1 };
    const main = roleSheet(mainCard, player.name);
    const sides = cards.filter(card => card !== mainCard).map(card => roleSheet(card, main.name));
    const before = textarea.value;
    const checkpoint = context.chat.slice();
    const controller = new AbortController();
    running = { controller, chatId, groupId: group.id };
    render();
    try {
        const story = readStory(checkpoint, main.id, context.chatMetadata);
        const turn = await playTurn({
            story, main, player, sides, input, signal: controller.signal,
            progress(message) {
                status = message;
                render();
            },
            async onUpdate({ turn: liveTurn, state }) {
                renderLivePreview(context, main, player, sides, liveTurn, state);
            },
            historyBudget: Math.max(1500, Math.min(18000, Math.round((context.maxContext || 4096) * 1.65))),
            async generate(systemPrompt, prompt) {
                // generateRawData does not include the active chat. Escape unknown macros in supplied data
                // so core SillyTavern does not expand them against the ambient group.
                const safe = text => text.replaceAll('{{', '{\u200B{');
                const data = await context.generateRawData({ systemPrompt: safe(systemPrompt), prompt: safe(prompt), api: context.mainApi });
                return context.extractMessageFromData(data, context.mainApi);
            },
        });
        controller.signal.throwIfAborted();
        const active = current();
        if (active.chatId !== chatId || active.group?.id !== group.id ||
            context.chat.length !== checkpoint.length || checkpoint.some((message, index) => context.chat[index] !== message)) {
            throw new Error('生成期间群聊已变化。本轮未写入，请在当前会话重试。');
        }

        running.saving = true;
        status = '正在保存本轮';
        render();
        removeLivePreview();
        const time = new Date().toISOString();
        const userMessage = { name: player.name, is_user: true, is_system: false, mes: input, send_date: time, extra: { [INPUT_KEY]: true } };
        const aiMessage = {
            name: main.name, is_user: false, is_system: false, send_date: time,
            force_avatar: context.getThumbnailUrl('avatar', main.id), original_avatar: main.id,
            mes: textOfTurn(turn, main, player, sides), extra: { [TURN_KEY]: turn },
        };
        // Pin the destination and its integrity header before awaiting I/O.
        const metadata = { ...context.chatMetadata, [STATE_KEY]: turn.state, tainted: true };
        const header = { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
        const response = await fetch('/api/chats/group/save', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ id: chatId, chat: [header, ...checkpoint, userMessage, aiMessage] }),
        });
        if (!response.ok) throw new Error('酒馆未能保存本轮。输入仍保留，请检查连接或刷新会话后重试。');
        const open = current();
        if (open.chatId !== chatId || open.group?.id !== group.id ||
            context.chat.length !== checkpoint.length || checkpoint.some((message, index) => context.chat[index] !== message)) {
            if (open.chatId === chatId) await context.reloadCurrentChat();
            status = '';
            return;
        }
        context.chatMetadata.tainted = true;
        context.chatMetadata[STATE_KEY] = turn.state;
        context.chat.push(userMessage, aiMessage);
        const userIndex = checkpoint.length;
        context.addOneMessage(userMessage);
        context.addOneMessage(aiMessage);
        if (textarea.value === before) {
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await context.eventSource.emit(context.eventTypes.USER_MESSAGE_RENDERED, userIndex);
        await context.eventSource.emit(context.eventTypes.CHARACTER_MESSAGE_RENDERED, userIndex + 1);
        status = '';
    } catch (error) {
        removeLivePreview();
        if (controller.signal.aborted) {
            status = '本轮已停止，可以重新发送。';
        } else {
            console.error('[PrivateRoutes]', error);
            showError(error instanceof Error ? error.message : '模型请求失败，请检查连接后重试。');
        }
    } finally {
        removeLivePreview();
        running = undefined;
        render();
    }
}

function onClick(event) {
    if (!(event.target instanceof Element) || !current().config?.enabled) return;
    if (event.target.closest(STOP_SELECTOR) && ui.sendForm.dataset.privateRoutesState) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
    } else if (event.target.closest(SEND_SELECTOR)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void send();
    } else if (event.target.closest(NATIVE_GENERATION + ', #rm_group_automode')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showError('多线模式下，请从聊天框发送消息推进剧情。');
    }
}

function onKey(event) {
    if (event.target?.id !== 'send_textarea' || event.key !== 'Enter' || event.shiftKey || event.altKey ||
        event.isComposing || event.keyCode === 229 || !shouldSendOnEnter() || !current().config?.enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void send();
}

function initialize() {
    const sendForm = document.querySelector('#send_form');
    if (ui || !sendForm) return;
    const root = document.createElement('div');
    root.id = 'private-routes';
    root.hidden = true;
    root.innerHTML = '<label><input type="checkbox"> 多线群聊</label>' +
        '<select aria-label="主卡"></select><span role="status" aria-live="polite"></span>';
    const [enabled, main, indicator] = root.querySelectorAll('input, select, span');
    ui = { root, enabled, main, status: indicator, sendForm };
    sendForm.before(root);
    enabled.addEventListener('change', () => {
        const { config } = current();
        if (!config) return;
        config.enabled = enabled.checked;
        status = '';
        getContext().saveSettingsDebounced();
        render();
    });
    main.addEventListener('change', () => {
        const { config } = current();
        if (!config) return;
        config.main = main.value;
        status = '';
        getContext().saveSettingsDebounced();
        render();
    });
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    const { eventSource, eventTypes } = getContext();
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        cancel();
        status = '';
        render();
    });
    eventSource.on(eventTypes.GROUP_UPDATED, render);
    eventSource.on(eventTypes.MESSAGE_DELETED, render);
    eventSource.on(eventTypes.CHARACTER_EDITED, render);
    render();
}

globalThis.privateRoutesBlockNativeGeneration = (chat, _contextSize, abort) => {
    const active = current();
    if (active.config?.enabled) {
        abort(true);
    } else if (active.group) {
        for (let index = chat.length - 1; index >= 0; index--) {
            if (chat[index].extra?.[TURN_KEY] || chat[index].extra?.[INPUT_KEY]) chat.splice(index, 1);
        }
    }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
