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

function asList(value) {
    const values = Array.isArray(value) ? value : (value ? [value] : []);
    return [...new Set(values.filter(item => typeof item === 'string' && item))];
}

function mainSelectionKey(value) {
    return asList(value).join('|');
}

function current(context = getContext()) {
    const group = context.groups.find(item => String(item.id) === String(context.groupId));
    if (!group || !context.chatId) return {};
    const groups = context.extensionSettings[SETTINGS_KEY] ??= {};
    const config = groups[String(group.id)] ??= { enabled: false, main: [], worldbook: [], stylePrompt: '' };
    config.main = asList(config.main);
    config.worldbook = asList(config.worldbook);
    config.stylePrompt = typeof config.stylePrompt === 'string' ? config.stylePrompt : '';
    const cards = group.members.map(id => context.characters.find(card => card.avatar === id)).filter(Boolean);
    return { group, config, cards, chatId: context.chatId };
}

function worldbookNames(context) {
    return typeof context.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : [];
}

function entryTargets(entry) {
    const meta = entry?.extensions?.privateRoutes;
    const target = meta?.target ?? entry?.privateRoutesTarget;
    if (target === undefined || target === null || target === '') return ['all'];
    return Array.isArray(target) ? target.map(String) : [String(target)];
}

function targetMatches(entry, role) {
    const targets = entryTargets(entry);
    return targets.includes('all') || targets.includes(role) || (role !== 'main' && targets.includes(role.name));
}

function regexKeyMatch(text, key) {
    if (typeof key !== 'string' || !key) return false;
    if (key.startsWith('/') && key.lastIndexOf('/') > 0) {
        const end = key.lastIndexOf('/');
        try {
            return new RegExp(key.slice(1, end), key.slice(end + 1)).test(text);
        } catch {
            return false;
        }
    }
    return text.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

function entryMatches(entry, text) {
    if (entry.constant || entry.extensions?.privateRoutes?.always) return true;
    const primary = Array.isArray(entry.key) ? entry.key : [];
    if (!primary.some(key => regexKeyMatch(text, key))) return false;
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
    if (!secondary.length) return true;
    const matches = secondary.filter(key => regexKeyMatch(text, key)).length;
    return Number(entry.selectiveLogic) === 1 ? matches === secondary.length : matches > 0;
}

function formatWorldbookEntries(data, role, scanText, includeTriggered) {
    const entries = data?.entries && typeof data.entries === 'object' ? Object.values(data.entries) : [];
    return entries
        .filter(entry => targetMatches(entry, role))
        .filter(entry => includeTriggered ? entryMatches(entry, scanText) : Boolean(entry.constant || entry.extensions?.privateRoutes?.always))
        .sort((a, b) => Number(a.order ?? a.insertion_order ?? 100) - Number(b.order ?? b.insertion_order ?? 100))
        .map(entry => typeof entry.content === 'string' ? entry.content.trim() : '')
        .filter(Boolean)
        .join('\n\n');
}

async function loadWorldRules(context, worldbooks, main, sides, input, checkpoint, story) {
    const selected = asList(worldbooks);
    if (!selected.length || typeof context.loadWorldInfo !== 'function') return { main: '', byRouteId: {} };
    const data = await Promise.all(selected.map(name => context.loadWorldInfo(name)));
    const allText = [...checkpoint.slice(-12).map(message => message.mes || ''), input].join('\n');
    const mainText = data.map(book => formatWorldbookEntries(book, 'main', allText, true)).filter(Boolean).join('\n\n');
    const byRouteId = {};
    for (const side of sides) {
        const ownText = [...(story?.events ?? []).filter(event => event.route === side.id).slice(-12).map(event => event.text), input].join('\n');
        byRouteId[side.id] = data.map(book => formatWorldbookEntries(book, side, ownText, false)).filter(Boolean).join('\n\n');
    }
    return { main: mainText, byRouteId };
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
    ui.worldbook.hidden = !config.enabled;
    ui.worldbook.disabled = Boolean(running);
    ui.style.hidden = !config.enabled;
    ui.style.disabled = Boolean(running);
    if (ui.style.value !== config.stylePrompt) ui.style.value = config.stylePrompt;
    ui.status.hidden = !config.enabled;
    if (!config.enabled) return;
    disableNativeAutoMode();
    ui.main.replaceChildren();
    const selectedMain = config.main.filter(id => cards.some(card => card.avatar === id));
    for (const card of cards) {
        const option = new Option(card.name, card.avatar);
        option.selected = selectedMain.includes(card.avatar);
        ui.main.append(option);
    }
    ui.worldbook.replaceChildren();
    const names = worldbookNames(context);
    const selectedBooks = config.worldbook.filter(name => names.includes(name));
    for (const name of names) {
        const option = new Option(name, name);
        option.selected = selectedBooks.includes(name);
        ui.worldbook.append(option);
    }
    const selectedMainNames = cards.filter(card => selectedMain.includes(card.avatar)).map(card => card.name);
    const selectedBookNames = selectedBooks.join('、');
    ui.status.textContent = status || (selectedMain.length
        ? sceneLabel(readStory(context.chat, mainSelectionKey(selectedMain), context.chatMetadata), cards, context.name1) +
            (selectedBookNames ? ' · 世界书：' + selectedBookNames : '')
        : '选择一张或多张主卡后发送消息');
    ui.main.title = selectedMainNames.length ? '主卡：' + selectedMainNames.join('、') : '可多选主卡';
    ui.worldbook.title = selectedBookNames ? '世界书：' + selectedBookNames : '可多选世界书';
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
            || (typeof data.system_prompt === 'string'
                && (data.system_prompt.includes('state_updates') || data.system_prompt.includes('【团子状态】'))),
    };
}

function mainGroup(cards, playerName) {
    const members = cards.map((card, index) => ({ ...roleSheet(card, playerName), key: 'm' + (index + 1) }));
    const id = mainSelectionKey(members.map(member => member.id));
    const name = members.map(member => member.name).join('、');
    return {
        id,
        name,
        avatar: members[0]?.id ?? id,
        sheet: { name, description: '由多张主卡共同负责规划本轮剧情。请根据 main_cards 保持每张主卡的独立口吻。' },
        members,
        showStatusBar: members.some(member => member.showStatusBar),
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

function affinityStage(score) {
    if (score <= 20) return '陌生';
    if (score <= 40) return '有点在意';
    if (score <= 60) return '有好感';
    if (score <= 80) return '喜欢';
    return '执念';
}

function affinityBar(score) {
    const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function statusBlock(turn, player, sides) {
    const state = turn.state ?? { affinity: {}, obsession: null };
    const identityRows = globalThis.privateRoutesIdentity?.statusRows?.({ state, playerRoute: { id: player.id ?? PLAYER } }) || [{ id: player.id ?? PLAYER, name: player.name, score: Number(state.affinity?.[player.id ?? PLAYER]) || 0 }];
    const routes = [...identityRows, ...sides.map(card => ({ id: card.id, name: card.name }))];
    const getScore = route => Math.max(0, Math.min(100, Number(state.affinity?.[route.id]) || 0));
    const rows = routes.map(route => {
        const score = Number.isFinite(Number(route.score)) ? Math.max(0, Math.min(100, Number(route.score))) : getScore(route);
        return `- **${markdownSafe(route.name)}**　\`${affinityBar(score)}\` ${score}/100 · ${affinityStage(score)}`;
    });
    const identityName = state.obsession ? globalThis.privateRoutesIdentity?.displayNameFor?.(state.obsession) : '';
    const fallbackUser = state.obsession === '$user' || state.obsession === 'user' ? '你' : '';
    const obsession = state.obsession ? (identityName || fallbackUser || stateLabel(state, state.obsession, routes)) : '无';
    return ['### 团子状态', '', ...rows, '', `心里那个人：**${markdownSafe(obsession)}**`].join('\n');
}

function textOfTurn(turn, main, player, sides, includeStatus = true, identityStatus = '') {
    const sections = [];
    const mainMembers = main.members?.length ? main.members : [{ id: main.id, name: main.name }];
    const identityRows = globalThis.privateRoutesIdentity?.statusRows?.({ state: turn.state, playerRoute: { id: player.id ?? PLAYER } }) || [{ id: player.id ?? PLAYER, name: player.name }];
    const activeIdentity = identityRows.find(identity => identity.id === (player.id ?? PLAYER)) || identityRows[0];
    const renderSection = (title, events, noAction = '主卡本轮无行为') => {
        const lines = events.map(event => {
            const speaker = event.kind === 'main' ? (event.fromName || main.name) : title;
            const queued = event.pending ? ' · 约会期间来信' : '';
            return '**' + markdownSafe(speaker) + '** · ' + storyClock(event.minute) + queued + '\n\n' + markdownSafe(cleanGeneratedText(event.text));
        });
        if (!events.some(event => event.kind === 'main')) lines.unshift(noAction);
        sections.push('### @' + markdownSafe(title) + '\n\n' + lines.join('\n\n'));
    };
    if (mainMembers.length > 1) {
        for (const member of mainMembers) {
            const events = turn.events.filter(event => event.route === activeIdentity.id && event.kind === 'main' && event.from === member.id)
                .sort((a, b) => a.minute - b.minute);
            renderSection(activeIdentity.name + ' · ' + member.name, events);
        }
    } else {
        const events = turn.events.filter(event => event.route === activeIdentity.id && ['main', 'side'].includes(event.kind))
            .sort((a, b) => a.minute - b.minute);
        renderSection(activeIdentity.name, events);
    }
    for (const identity of identityRows) {
        if (identity.id === activeIdentity.id) continue;
        renderSection(identity.name, []);
    }
    for (const route of sides) {
        const events = turn.events.filter(event => event.route === route.id && ['main', 'side'].includes(event.kind))
            .sort((a, b) => a.minute - b.minute);
        renderSection(route.name, events);
    }
    const body = sections.join('\n\n---\n\n');
    const blocks = [];
    if (includeStatus && main.showStatusBar) blocks.push(statusBlock(turn, player, sides));
    if (identityStatus) blocks.push(identityStatus);
    return blocks.length ? body + '\n\n' + blocks.join('\n\n') : body;
}

function stateLabel(state, routeId, routes) {
    return routes.find(route => route.id === routeId)?.name ?? '无';
}

function syncStateVariables(context, state, main, player, sides) {
    const local = context.variables?.local;
    if (!local) return;
    const playerId = player.id ?? PLAYER;
    const routes = [{ id: playerId, name: player.name }, ...sides.map(card => ({ id: card.id, name: card.name }))];
    const affinity = state?.affinity ?? {};
    const familiarity = state?.familiarity ?? {};
    const tension = state?.tension ?? {};
    const stage = state?.stage ?? {};
    const unresolved = state?.unresolved ?? {};
    const value = id => String(Number.isFinite(Number(affinity[id])) ? affinity[id] : 0);
    const relationKey = (route, index) => route.id === playerId
        ? 'me'
        : `route_${index}`;
    local.set('aff_me', value(playerId));
    local.set('aff_user', value(playerId));
    local.set('relationship_mode', state?.relationshipMode || 'new');
    for (const [index, route] of routes.entries()) {
        const key = relationKey(route, index);
        local.set(`familiarity_${key}`, String(Number.isFinite(Number(familiarity[route.id])) ? familiarity[route.id] : 0));
        local.set(`tension_${key}`, String(Number.isFinite(Number(tension[route.id])) ? tension[route.id] : 0));
        local.set(`relationship_stage_${key}`, String(stage[route.id] || '初识'));
        local.set(`unresolved_${key}`, JSON.stringify(Array.isArray(unresolved[route.id]) ? unresolved[route.id] : []));
    }
    const luye = routes.find(route => route.name === '路野' || route.name === '周野');
    const lushi = routes.find(route => route.name === '陆时');
    if (luye) {
        local.set('aff_luye', value(luye.id));
        local.set('aff_zhouye', value(luye.id));
    }
    if (lushi) local.set('aff_lushi', value(lushi.id));
    local.set('obsession_name', stateLabel(state, state?.obsession, routes));
}

function renderLivePreview(context, main, player, sides, turn, state, identityStatusText = '') {
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
    const body = textOfTurn(turn, main, player, sides, true, identityStatusText);
    preview.innerHTML = '<div class="private-routes-live-label">正在生成多线回复…</div><div class="private-routes-live-content"></div>';
    const content = preview.querySelector('.private-routes-live-content');
    content.innerHTML = context.messageFormatting(body, main.name, false, false, -1, {}, false);
}

function removeLivePreview() {
    document.querySelector('#private-routes-live')?.remove();
}

async function prepareIdentity(context, payload) {
    const api = globalThis.privateRoutesIdentity;
    if (!api?.prepareTurn) return null;
    return await api.prepareTurn({ context, ...payload });
}

function identityStatus(api, payload) {
    return '';
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

function regenerate() {
    void send({ regenerate: true });
}

async function send({ regenerate = false } = {}) {
    if (running) return;
    const context = getContext();
    const { group, config, cards, chatId } = current(context);
    if (!config?.enabled) return;
    const textarea = document.querySelector('#send_textarea');
    const originalChat = context.chat.slice();
    let input = textarea?.value.trim();
    let checkpoint = originalChat;
    if (regenerate) {
        const aiIndex = originalChat.length - 1;
        const userIndex = aiIndex - 1;
        const previousUser = originalChat[userIndex];
        const previousAi = originalChat[aiIndex];
        if (!previousUser?.extra?.[INPUT_KEY] || !previousAi?.extra?.[TURN_KEY]) {
            return showError('上一条不是多线群聊回复，无法由扩展重新生成。');
        }
        input = String(previousUser.mes || '').trim();
        checkpoint = originalChat.slice(0, userIndex);
    }
    if (!input) return;
    const selectedMainIds = asList(config.main).filter(id => cards.some(card => card.avatar === id));
    const selectedMainCards = cards.filter(card => selectedMainIds.includes(card.avatar));
    if (!selectedMainCards.length) return showError('请先选择一张或多张主卡。');
    if (context.onlineStatus === 'no_connection') return showError('请先连接酒馆的模型。');
    if (document.querySelector('#file_form_input')?.files?.length || document.querySelector('#embed_file_input')?.files?.length) {
        return showError('多线群聊目前支持文本。请先移除附件。');
    }
    const before = textarea.value;
    const controller = new AbortController();
    running = { controller, chatId, groupId: group.id, regenerate };
    render();
    try {
        const identityApi = globalThis.privateRoutesIdentity;
        const identity = await prepareIdentity(context, { chatId, group, input, chat: checkpoint, playerName: context.name1 });
        const player = identity?.player
            ? { ...identity.player, id: identity.playerRoute?.id }
            : { name: context.name1, id: PLAYER };
        const main = mainGroup(selectedMainCards, player.name);
        const sides = cards.filter(card => !selectedMainIds.includes(card.avatar)).map(card => roleSheet(card, main.name));
        const storyMetadata = regenerate ? { ...context.chatMetadata, [STATE_KEY]: null } : context.chatMetadata;
        const story = readStory(checkpoint, main.id, storyMetadata);
        if (identity?.stateOverride) story.state = identity.stateOverride;
        const worldRules = await loadWorldRules(context, config.worldbook, main, sides, input, checkpoint, story);
        const turn = await playTurn({
            story, main, mainCards: main.members, player, playerRoute: identity?.playerRoute, sides, input, worldRules, signal: controller.signal,
            progress(message) {
                status = message;
                render();
            },
            async onUpdate({ turn: liveTurn, state }) {
                renderLivePreview(context, main, player, sides, liveTurn, state, identityStatus(identityApi, { state, playerRoute: identity?.playerRoute }));
            },
            historyBudget: Math.max(1500, Math.min(18000, Math.round((context.maxContext || 4096) * 1.65))),
            stylePrompt: config.stylePrompt,
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
            context.chat.length !== originalChat.length || originalChat.some((message, index) => context.chat[index] !== message)) {
            throw new Error('生成期间群聊已变化。本轮未写入，请在当前会话重试。');
        }

        running.saving = true;
        status = '正在保存本轮';
        render();
        removeLivePreview();
        const time = new Date().toISOString();
        const userMessage = { name: player.name, is_user: true, is_system: false, mes: input, send_date: time, extra: { [INPUT_KEY]: true } };
        if (identityApi?.commitTurn) await identityApi.commitTurn({ context, chatId, turn, playerRoute: identity?.playerRoute });
        const aiMessage = {
            name: main.name, is_user: false, is_system: false, send_date: time,
            force_avatar: context.getThumbnailUrl('avatar', main.avatar), original_avatar: main.avatar,
            mes: textOfTurn(turn, main, player, sides, true, identityStatus(identityApi, { state: turn.state, playerRoute: identity?.playerRoute })), extra: { [TURN_KEY]: turn },
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
            context.chat.length !== originalChat.length || originalChat.some((message, index) => context.chat[index] !== message)) {
            if (open.chatId === chatId) await context.reloadCurrentChat();
            status = '';
            return;
        }
        if (regenerate) {
            await context.reloadCurrentChat();
            if (textarea.value === before) {
                textarea.value = '';
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
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
    } else if (event.target.closest('#option_regenerate')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        regenerate();
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
        '<label>主卡<select aria-label="主卡（可多选）" multiple size="3"></select></label>' +
        '<label>关系世界书<select aria-label="关系世界书（可多选）" multiple size="3"></select></label>' +
        '<label class="private-routes-style-label">预设文风' +
        '<textarea aria-label="预设文风" rows="4" maxlength="12000" ' +
        'placeholder="粘贴当前酒馆预设中的文风、人称、句式、语言和角色口吻规则。多线 JSON 协议会自动保持最高优先级。明确写“让某副卡……”“@某副卡……”时，会生成该副卡的导演指令。"></textarea>' +
        '</label>' +
        '<span role="status" aria-live="polite"></span>';
    const enabled = root.querySelector('input[type="checkbox"]');
    const main = root.querySelector('select[aria-label="主卡（可多选）"]');
    const worldbook = root.querySelector('select[aria-label="关系世界书（可多选）"]');
    const style = root.querySelector('textarea[aria-label="预设文风"]');
    const indicator = root.querySelector('span[role="status"]');
    ui = { root, enabled, main, worldbook, style, status: indicator, sendForm };
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
        config.main = [...main.selectedOptions].map(option => option.value);
        status = '';
        getContext().saveSettingsDebounced();
        render();
    });
    worldbook.addEventListener('change', () => {
        const { config } = current();
        if (!config) return;
        config.worldbook = [...worldbook.selectedOptions].map(option => option.value);
        status = '';
        getContext().saveSettingsDebounced();
        render();
    });
    style.addEventListener('input', () => {
        const { config } = current();
        if (!config) return;
        config.stylePrompt = style.value;
        getContext().saveSettingsDebounced();
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
