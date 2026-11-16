export const TURN_KEY = 'privateRoutesTurn';
export const STATE_KEY = 'privateRoutesState';
export const PLAYER = '$user';
const MAIN_SYSTEM = '你扮演主卡。使用与当前对话相同的语言，遵守角色设定，保持每条关系的连续性。你知道所有分线，但一般不把另一条线的内容泄露给当事人，除非剧情中的主卡有意转述。不要替其他角色说话或决定行动，不要让玩家的输入直接作用于副卡。只输出要求的 JSON 对象。状态数据放在 state_updates 字段中，不要把 <state>、【团子状态】、HTML 或状态栏放进任何 actions.text。';
const SIDE_SYSTEM = '你只扮演当前副卡，依据这条关系的经历和自己的人设独立行动。只写本角色实际对主卡做的动作或说的话。你只了解已提供给你的内容。只输出要求的 JSON 对象。';
const MAX_TEXT = 6500;

function decode(raw) {
    let text = String(raw).trim();
    const fenced = text.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);
    if (fenced) text = fenced[1];
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型没有返回 JSON 对象。');
    return value;
}

function check(condition, reason) {
    if (!condition) throw new Error(reason);
}

async function ask(generate, system, instructions, data, validate, signal) {
    let hint = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const raw = await generate(system, instructions + hint + '\n\n本次资料（JSON）\n' + JSON.stringify(data));
        signal.throwIfAborted();
        try {
            return validate(decode(raw));
        } catch (error) {
            hint = '\n上一次格式错误，请重新生成。' + (error instanceof SyntaxError ? '请返回有效 JSON。' : error.message);
            if (attempt === 1) throw new Error('模型连续两次返回了无效的剧情结构。' + hint.trim());
        }
    }
}

function narrativeText(value, required = false) {
    check(typeof value === 'string' && value.length <= MAX_TEXT, '对白或动作必须是长度合适的文本。');
    const result = value.trim();
    check(!required || result, '被点到的角色必须实际回应。');
    return result;
}

function relativeMinute(value, start, end) {
    check(Number.isSafeInteger(value) && value >= start && value <= end, '发言时间须落在本轮允许的分钟范围内。');
    return value;
}

function cloneState(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeState(value, routes) {
    const state = value && typeof value === 'object' ? value : {};
    const affinity = {};
    const oldKeys = new Map([
        ['aff_me', PLAYER],
        ['aff_user', PLAYER],
        ['aff_zhouye', routes.find(route => route.name === '路野' || route.name === '周野')?.id],
        ['aff_luye', routes.find(route => route.name === '路野' || route.name === '周野')?.id],
        ['aff_lushi', routes.find(route => route.name === '陆时')?.id],
    ]);
    const source = state.affinity && typeof state.affinity === 'object' ? state.affinity : state;
    for (const route of routes) {
        let score = Number(source[route.id]);
        if (!Number.isFinite(score)) {
            for (const [key, id] of oldKeys) {
                if (id === route.id && Number.isFinite(Number(source[key]))) {
                    score = Number(source[key]);
                    break;
                }
            }
        }
        affinity[route.id] = Math.max(0, Math.min(100, Math.round(Number.isFinite(score) ? score : 0)));
    }
    const obsession = typeof state.obsession === 'string' && routes.some(route => route.id === state.obsession)
        ? state.obsession
        : null;
    return { version: 1, affinity, obsession };
}

function parseStateUpdates(value, allowed) {
    if (value.state_updates === undefined) return [];
    check(Array.isArray(value.state_updates), 'state_updates 必须是数组。');
    const used = new Set();
    return value.state_updates.map(update => {
        check(update && allowed.includes(update.to) && !used.has(update.to), 'state_updates 只能使用允许的对象编号，每个对象一项。');
        used.add(update.to);
        check(Number.isSafeInteger(update.affinity_delta) && update.affinity_delta >= -10 && update.affinity_delta <= 10, 'affinity_delta 必须是 -10 到 10 的整数。');
        return { to: update.to, affinityDelta: update.affinity_delta };
    });
}

export function storyClock(minute) {
    const day = Math.floor(minute / 1440) + 1;
    const hour = String(Math.floor((minute % 1440) / 60)).padStart(2, '0');
    return '第' + day + '天 ' + hour + ':' + String(minute % 60).padStart(2, '0');
}

export function readStory(chat, mainId, metadata = {}) {
    const story = { minute: 0, date: null, events: [], state: metadata[STATE_KEY] ?? null };
    for (const message of chat) {
        const turn = message.extra?.[TURN_KEY];
        if (turn?.version !== 1 || turn.main !== mainId || !Array.isArray(turn.events)) continue;
        story.minute = turn.minute;
        story.date = turn.date;
        story.events.push(...turn.events);
        if (turn.state) story.state = turn.state;
    }
    return story;
}

function recent(events, limit) {
    const result = [];
    for (let index = events.length - 1; index >= 0 && limit > 70; index--) {
        const { kind, text, minute } = events[index];
        const shortened = text.slice(-Math.floor(limit - 70));
        result.unshift({ by: kind, time: storyClock(minute), text: shortened });
        limit -= shortened.length + 70;
    }
    return result;
}

function pending(events, id) {
    const result = [];
    for (const event of events) {
        if (event.route !== id) continue;
        if (event.handled) result.length = 0;
        if (event.pending) result.push(event);
    }
    return result;
}

function routeData(state, routes, limit) {
    return routes.map(({ id, key, name }) => {
        const events = state.events.filter(event => event.route === id);
        return {
            to: key,
            name,
            history: recent(events, limit / Math.max(routes.length, 1)),
            waiting: pending(events, id).map(event => ({ time: storyClock(event.minute), text: event.text })),
        };
    });
}

function segments(items, allowed, required = []) {
    check(Array.isArray(items), 'actions 必须是数组。');
    const used = new Set();
    const result = [];
    for (const row of items) {
        check(row && allowed.includes(row.to) && !used.has(row.to), 'actions 只能使用允许的对象编号，每个对象一段。');
        used.add(row.to);
        const text = narrativeText(row.text);
        if (text) result.push({ to: row.to, text });
    }
    check(required.every(id => result.some(action => action.to === id)), '有待回复消息的对象需要各自收到一段回复。');
    return result;
}

export async function playTurn({ story, main, player, sides, input, generate, signal, progress, onUpdate, historyBudget = 11000 }) {
    const routes = [{ ...player, id: PLAYER, key: 'user' }, ...sides.map((card, index) => ({ ...card, key: 'c' + (index + 1) }))];
    const byKey = new Map(routes.map(route => [route.key, route]));
    const keyFor = id => routes.find(route => route.id === id)?.key;
    const previousDate = story.date;
    const previousKey = keyFor(previousDate);
    check(!previousDate || previousKey, '当前约会对象已移出群聊，请恢复该成员后继续剧情。');

    const state = { events: [...story.events], minute: story.minute, date: previousDate };
    const routeState = normalizeState(story.state, routes);
    const turn = { version: 1, main: main.id, minute: story.minute, date: previousDate, focus: previousDate, events: [], state: cloneState(routeState) };
    const emit = (route, kind, text, minute, flags = {}) => {
        const event = { route, kind, text, minute, ...flags };
        turn.events.push(event);
        state.events.push(event);
        return event;
    };
    const common = () => ({
        main: main.sheet,
        at: storyClock(state.minute),
        routes: routeData(state, routes, historyBudget),
        relationship_state: {
            affinity: routes.reduce((result, route) => ({ ...result, [route.key]: routeState.affinity[route.id] }), {}),
            obsession: keyFor(routeState.obsession) ?? null,
        },
    });
    const applyStateUpdates = updates => {
        for (const update of updates) {
            const route = byKey.get(update.to);
            if (!route) continue;
            const current = routeState.affinity[route.id] ?? 0;
            routeState.affinity[route.id] = Math.max(0, Math.min(100, current + update.affinityDelta));
        }
        if (!routeState.obsession) {
            const candidate = routes.find(route => routeState.affinity[route.id] >= 81);
            if (candidate) routeState.obsession = candidate.id;
        }
        if (routeState.obsession) {
            for (const route of routes) {
                if (route.id !== routeState.obsession) routeState.affinity[route.id] = Math.min(80, routeState.affinity[route.id]);
            }
        }
        turn.state = cloneState(routeState);
    };
    const publish = async () => {
        turn.state = cloneState(routeState);
        if (onUpdate) await onUpdate({ turn, state: cloneState(routeState) });
    };
    progress('正在生成 ' + main.name + ' 的行动');
    const plan = await ask(generate, MAIN_SYSTEM, [
        '处理玩家新输入并推进剧情。线上互动按对象给出独立行动，空字符串代表无行动。时间来自剧情，未发生时间推移可填 0。当前时间从第 1 天 00:00 起算。',
        '只有实际见面进入线下约会，线上邀约不算。如果开始或结束时间在本轮内，用相对于本轮开始的分钟数。正在约会时保留相同对象，startsAt 填 null，endsAt 为 null 时约会继续。如果本轮无约会，date 填 null。',
        '只要本轮包含约会，actions 只允许约会对象，此处仅写约会内的互动。集中回复要等下一步。在线上时，actions 可写任一对象。',
        'inputKind 为 "message" 时，玩家文本是发给主卡的话。只有纯剧情指令、时间跳转或旁白时填 "narration"；和玩家约会时，玩家写给主卡的台词与动作仍归入双方情节。',
        '格式 {"elapsed":0,"inputKind":"message","date":null,"actions":[{"to":"user","text":"行动或台词"}],"state_updates":[{"to":"user","affinity_delta":0}]}。date 对象格式 {"with":"c1","startsAt":0,"endsAt":null}。每个 to 使用 routes 中的编号，禁止在 text 里代写其他人的回复。state_updates 只记录本轮感情变化，没有变化就返回空数组。',
    ].join('\n'), { ...common(), activeDate: previousKey ?? null, playerInput: input }, value => {
        const elapsed = relativeMinute(value.elapsed, 0, Number.MAX_SAFE_INTEGER - story.minute);
        check(['message', 'narration'].includes(value.inputKind), 'inputKind 必须是 message 或 narration。');
        let date = null;
        if (value.date !== null) {
            const spec = value.date;
            check(spec && byKey.has(spec.with), '约会对象编号无效。');
            check(!previousKey || (previousKey === spec.with && spec.startsAt === null), '进行中的约会须保留原对象且 startsAt 为 null。');
            const start = previousKey ? 0 : relativeMinute(spec.startsAt, 0, elapsed);
            const end = spec.endsAt === null ? elapsed : relativeMinute(spec.endsAt, start, elapsed);
            date = { key: spec.with, id: byKey.get(spec.with).id, start, end, ends: spec.endsAt !== null };
        } else {
            check(!previousKey, '已有约会时需要明确填入约会对象和是否结束。');
        }
        const allowed = date ? [date.key] : [...byKey.keys()];
        return { elapsed, date, inputKind: value.inputKind, actions: segments(value.actions, allowed), stateUpdates: parseStateUpdates(value, [...byKey.keys()]) };
    }, signal);

    const start = story.minute;
    const end = start + plan.elapsed;
    const date = plan.date;
    applyStateUpdates(plan.stateUpdates);
    state.minute = end;
    state.date = date && !date.ends ? date.id : null;
    turn.minute = end;
    turn.focus = date?.id ?? null;
    turn.date = state.date;
    if (plan.inputKind === 'message') {
        const queued = date && date.id !== PLAYER;
        emit(PLAYER, 'user', input, start, queued ? { pending: true } : {});
    } else {
        const active = date?.id ?? PLAYER;
        // Scene directions are only provided to the main model, never to a side.
        emit(active, 'direction', input, start);
    }

    const sendMain = (actions, minute, handled = []) => actions.map(({ to, text }) => {
        const route = byKey.get(to);
        return emit(route.id, 'main', text, minute, handled.includes(to) ? { handled: true } : {});
    });

    const sendSide = async (route, action, { from, until, background = false }) => {
        progress(background ? route.name + ' 正在独立行动' : '等待 ' + route.name + ' 回应');
        const own = state.events.filter(event => event.route === route.id && event.kind !== 'direction');
        const messages = await ask(generate, SIDE_SYSTEM, [
            action ? '主卡已对你采取行动，你必须回应一次。'
                : background ? '根据你自己的经历决定在这段时间里要不要主动给主卡发消息。只写发出去的消息，可以一条都不发。'
                    : '你可以根据自己的经历主动联系主卡，或跳过本轮。最多一条。',
            '返回 {"messages":[{"at":0,"text":"你的实际台词或动作"}]}。at 是相对于本轮起点的分钟数，范围 [fromOffset, untilOffset]；请按时间从早到晚输出。无动作时返回 {"messages":[]}。',
        ].join('\n'), {
            character: route.sheet,
            partner: main.name,
            history: recent(own, historyBudget),
            latestAction: action?.text ?? null,
            startsAt: storyClock(start),
            fromOffset: from - start,
            untilOffset: until - start,
        }, value => {
            check(Array.isArray(value.messages) && value.messages.length <= (background ? 8 : 1), 'messages 数组的条数超出本次允许范围。');
            check(!action || value.messages.length === 1, '被点到时 messages 必须有一条回复。');
            return value.messages.map(item => {
                check(item && typeof item === 'object', 'messages 中缺少消息对象。');
                return {
                    text: narrativeText(item.text, true),
                    minute: start + relativeMinute(item.at, from - start, until - start),
                };
            }).sort((a, b) => a.minute - b.minute);
        }, signal);
        return messages.map(message => emit(route.id, 'side', message.text, message.minute, background ? { pending: true } : {}));
    };

    const mainWrites = async (eligible, must, instructions, latest) => {
        progress(main.name + ' 正在决定如何接话');
        return ask(generate, MAIN_SYSTEM, '本步骤只写主卡说的话或做的事。' + instructions +
            '\n格式 {"actions":[{"to":"c1","text":"行动或台词"}],"state_updates":[{"to":"c1","affinity_delta":0}]}。允许参与的编号在 eligible 中，必须回复的编号在 mustReply 中。无行动可返回 {"actions":[]}。state_updates 只记录本轮感情变化，没有变化就返回空数组。',
        { ...common(), eligible, mustReply: must, latest: latest.map(event => ({
            to: keyFor(event.route), text: event.text, time: storyClock(event.minute),
        })) }, value => ({ actions: segments(value.actions, eligible, must), stateUpdates: parseStateUpdates(value, eligible) }), signal);
    };

    const responses = [];
    const deferred = [];
    const actions = sendMain(plan.actions, date ? start + date.end : end);
    await publish();
    for (const route of routes.slice(1)) {
        const action = actions.find(entry => entry.route === route.id);
        if (date && date.id !== route.id) {
            if (date.end > date.start) {
                deferred.push(...await sendSide(route, null, { from: start + date.start, until: start + date.end, background: true }));
                await publish();
            }
        } else {
            responses.push(...await sendSide(route, action, {
                from: action?.minute ?? (date ? start + date.start : end),
                until: date ? start + date.end : end,
            }));
            await publish();
        }
    }

    if (!state.date) {
        const ready = routes.filter(route => pending(state.events, route.id).length);
        if (ready.length) {
            const keys = ready.map(route => route.key);
            const replies = await mainWrites(keys, keys, '约会已结束或已有待补回的来信。在同一次输出中按对象分别集中回复待处理消息。', deferred);
            applyStateUpdates(replies.stateUpdates);
            for (const action of sendMain(replies.actions, end, keys)) {
                const route = routes.find(candidate => candidate.id === action.route);
                if (route.id !== PLAYER) responses.push(...await sendSide(route, action, { from: end, until: end }));
            }
            await publish();
        }
    }

    let latest = responses;
    while (latest.length) {
        const keys = [...new Set(latest.map(event => keyFor(event.route)))];
        const replies = await mainWrites(keys, [], '自行决定现在是否接话。剧情适合收尾或可以等用户下一轮时，返回空数组。不要为了填满回合而继续。', latest);
        applyStateUpdates(replies.stateUpdates);
        if (!replies.actions.length) break;
        latest = [];
        for (const action of sendMain(replies.actions, end)) {
            const route = routes.find(candidate => candidate.id === action.route);
            latest.push(...await sendSide(route, action, { from: end, until: end }));
        }
        await publish();
    }

    return turn;
}
