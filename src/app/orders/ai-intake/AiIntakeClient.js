'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { renderChatText } from './formatChatText';

const STATUS_LABEL = {
  bot: '봇 응대중',
  needs_agent: '상담원 대기',
  agent_active: '상담원 응대중',
  closed: '종료',
};

const STATUS_BADGE = {
  bot: 'gray',
  needs_agent: 'red',
  agent_active: 'blue',
  closed: 'dark',
};

const ORDER_FIELD_IDS = [
  'reserved_date',
  'reserved_time',
  'origin_address',
  'origin_detail_address',
  'origin_contact',
  'destination_address',
  'destination_detail_address',
  'destination_contact',
  'vehicle_type',
  'vehicle_number',
  'memo_customer',
  'memo_billing',
];

const FIELD_KEYWORDS = [
  { id: 'origin_address', label: '출발지 주소', re: /(출발지|출발 주소|상차지|픽업지)/i },
  { id: 'origin_contact', label: '출발지 연락처', re: /(출발지 연락처|출발 연락처|상차 연락처)/i },
  { id: 'destination_address', label: '도착지 주소', re: /(도착지|도착 주소|하차지)/i },
  { id: 'destination_contact', label: '도착지 연락처', re: /(도착지 연락처|도착 연락처|하차 연락처)/i },
  { id: 'vehicle_type', label: '차종', re: /(차종|차량 종류|차량 타입)/i },
  { id: 'vehicle_number', label: '차량번호', re: /(차량번호|차 번호|번호판)/i },
  { id: 'reserved_date', label: '예약일시', re: /(예약|시간|일시|날짜)/i },
  { id: 'memo_customer', label: '기사 전달사항', re: /(기사 전달|기사 메모|요청사항)/i },
  { id: 'memo_billing', label: '업체 전달사항', re: /(업체 전달|정산 메모|청구 메모)/i },
];

const TROUBLE_STREAK_LIMIT = 2;
const VEHICLE_NUMBER_RE = /\d{2,3}[가-힣]\d{4}$/;
const VEHICLE_NUMBER_SKIP_RE = /(다음|없음|미정|모름|나중|패스|skip)/i;
const ADDITIONAL_REQUEST_NONE_RE = /^(없음|없어요|없습니다|없다|없어)$/i;
const NEW_ORDER_WHILE_WAITING_RE = /(탁송|접수|예약|대리|일일\s?기사|오더|출발|도착|경유|요금|주소)/;

const PENDING_FIELD_PROMPTS = {
  origin_address: '출발지 주소를 다시 입력해주세요. 예: 판교역 1번출구',
  origin_contact: '출발지 연락처를 다시 입력해주세요. 예: 010-1234-5678',
  destination_address: '도착지 주소를 다시 입력해주세요. 예: 강남역 4번출구',
  destination_contact: '도착지 연락처를 다시 입력해주세요. 예: 010-1234-5678',
  vehicle_type: '차종을 다시 입력해주세요. 예: 카니발, 1톤',
  vehicle_number: '차량번호를 다시 입력해주세요. 예: 12가3456',
  reserved_date: '예약일시를 다시 입력해주세요. 예: 내일 오후 3시',
  memo_customer: '기사 전달사항이 있으면 입력하고, 없으면 "없음"이라고 입력해주세요.',
  memo_billing: '업체 전달사항이 있으면 입력해주세요.',
};

function toUiMessage(message) {
  return {
    id: message.id,
    sender: message.sender,
    text: message.message,
  };
}

function maxMessageId(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((max, item) => {
    const n = Number(item && item.id);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
}

function createSeenIdSet(items) {
  const set = new Set();
  if (!Array.isArray(items)) return set;
  items.forEach((item) => {
    const n = Number(item && item.id);
    if (Number.isFinite(n) && n > 0) set.add(n);
  });
  return set;
}

function toIncomingMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const id = Number(payload.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const sender = payload.sender || 'bot';
  if (!['user', 'bot', 'agent', 'system'].includes(sender)) return null;
  return {
    id,
    sender,
    text: String(payload.message || ''),
  };
}

function buildFaqMessage(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return '죄송합니다, 관련된 답변을 찾지 못했습니다. 다른 표현으로 다시 질문해주세요.';
  }
  return matches
    .map((item) => '[' + (item.category || '안내') + '] ' + (item.answer || ''))
    .join('\n');
}

function buildOrderSummary(parseData) {
  const fields = [
    ['예약일시', [parseData.reserved_date, parseData.reserved_time].filter(Boolean).join(' ')],
    ['출발지', [parseData.origin_address, parseData.origin_detail_address].filter(Boolean).join(' ')],
    ['도착지', [parseData.destination_address, parseData.destination_detail_address].filter(Boolean).join(' ')],
    ['차량번호', parseData.vehicle_number],
    ['차종', parseData.vehicle_type],
    ['출발지 연락처', parseData.origin_contact],
    ['도착지 연락처', parseData.destination_contact],
  ]
    .filter(([, value]) => !!String(value || '').trim())
    .map(([label, value]) => '- ' + label + ': ' + value);

  if (fields.length === 0) {
    return '오더 접수 의도로 인식했지만 추출된 항목이 아직 없습니다. 내용을 조금 더 자세히 입력해주세요.';
  }

  return ['입력 내용을 오더 접수로 인식했습니다.', ...fields, '필요한 정보를 더 말씀해주시면 계속 보완하겠습니다.'].join('\n');
}

function isOrderIntent(parseData) {
  if (!parseData || typeof parseData !== 'object') return false;
  return !['faq', 'greeting', 'unsupported'].includes(parseData.intent);
}

function pickOrderFields(parseData) {
  const next = {};
  if (!parseData || typeof parseData !== 'object') return next;
  ORDER_FIELD_IDS.forEach((key) => {
    if (parseData[key] !== undefined && parseData[key] !== null && String(parseData[key]).trim() !== '') {
      next[key] = String(parseData[key]).trim();
    }
  });
  if (!next.vehicle_number && parseData.origin_vehicle_number) {
    next.vehicle_number = String(parseData.origin_vehicle_number).trim();
  }
  return next;
}

function mergeOrderFields(prevFields, patchFields) {
  return Object.assign({}, prevFields || {}, patchFields || {});
}

function isAffirmative(text) {
  return /^(네|넵|예|응|오케이|ok|yes|맞아요?|맞습니다|좋아요?)[.!~\s]*$/i.test(String(text || '').trim());
}

function isNegative(text) {
  return /(아니|아뇨|아니요|수정|바꿔|틀려|잘못)/i.test(String(text || '').trim());
}

function isAgentRequest(text) {
  return /(상담원|상담사|사람 연결|직원 연결)/i.test(String(text || '').trim());
}

function looksLikeOrderIntake(text) {
  const t = String(text || '');
  return /\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}/.test(t)
    || /(^|[\n\s])(출발|출:|출\s|도착|도:|도\s|경유|경:|경\d)/.test(t);
}

function looksLikeNewOrderWhileWaiting(text) {
  const t = String(text || '');
  return looksLikeOrderIntake(t) || NEW_ORDER_WHILE_WAITING_RE.test(t);
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!/^0\d{9,10}$/.test(digits)) return null;
  if (digits.length === 10) return digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
  return digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3');
}

function extractPhone(text) {
  const m = String(text || '').match(/0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/);
  if (!m) return null;
  return normalizePhone(m[0]);
}

function findFieldByKeyword(text) {
  const value = String(text || '');
  for (let i = 0; i < FIELD_KEYWORDS.length; i += 1) {
    if (FIELD_KEYWORDS[i].re.test(value)) return FIELD_KEYWORDS[i];
  }
  return null;
}

function candidateListText(disambiguation) {
  if (!disambiguation || !Array.isArray(disambiguation.candidates) || disambiguation.candidates.length === 0) {
    return '주소 후보를 확인할 수 없습니다.';
  }
  const lines = [`${disambiguation.label || '주소'}가 여러 개 확인되었습니다. 어느 곳이 맞을까요?`];
  disambiguation.candidates.forEach((c, idx) => {
    lines.push(`${idx + 1}) ${c.label}`);
  });
  return lines.join('\n');
}

function extractDisambiguations(parseData) {
  if (!parseData || typeof parseData !== 'object') return [];

  const toItem = (item) => {
    if (!item || typeof item !== 'object') return null;
    const fieldId = item.fieldId || item.field_id || null;
    const label = item.label || item.fieldLabel || item.field_label || '주소';
    const rawCandidates = Array.isArray(item.candidates) ? item.candidates : [];
    const candidates = rawCandidates
      .map((c) => {
        if (typeof c === 'string') return { label: c, value: c };
        if (!c || typeof c !== 'object') return null;
        const v = c.value || c.address || c.label || '';
        const l = c.label || c.address || c.value || '';
        if (!l) return null;
        return { label: String(l), value: String(v || l) };
      })
      .filter(Boolean);
    if (!fieldId || candidates.length < 2) return null;
    return { fieldId, label, candidates };
  };

  if (parseData.disambiguation) {
    const one = toItem(parseData.disambiguation);
    return one ? [one] : [];
  }
  if (Array.isArray(parseData.disambiguations)) {
    return parseData.disambiguations.map(toItem).filter(Boolean);
  }
  if (Array.isArray(parseData.ambiguousFields)) {
    return parseData.ambiguousFields.map(toItem).filter(Boolean);
  }
  return [];
}

function resolveBotDraft(parseData) {
  if (!parseData || typeof parseData !== 'object') {
    return { message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.', needsAgent: false, requestedFeature: null };
  }

  if (parseData.intent === 'greeting') {
    return {
      message:
        parseData.message ||
        '안녕하세요. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.',
      needsAgent: false,
      requestedFeature: null,
    };
  }

  if (parseData.intent === 'faq') {
    return {
      message: buildFaqMessage(parseData.matches),
      needsAgent: false,
      requestedFeature: null,
    };
  }

  if (parseData.intent === 'unsupported') {
    return {
      message: null,
      needsAgent: true,
      requestedFeature: parseData.requestedFeature || null,
    };
  }

  return {
    message: buildOrderSummary(parseData),
    needsAgent: false,
    requestedFeature: null,
  };
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
  }
  return data;
}

export default function AiIntakeClient({
  initialSession,
  initialMessages,
  initialDraft,
  defaultGreeting,
  onOrderPrefill,
  serverTurnEnabled,
}) {
  const initialDraftState = initialDraft && typeof initialDraft === 'object' ? initialDraft : null;
  const initialDraftFields = (initialDraftState && initialDraftState.fields && typeof initialDraftState.fields === 'object')
    ? initialDraftState.fields
    : {};

  const restoredMessages = Array.isArray(initialMessages) ? initialMessages.map(toUiMessage) : [];
  const [sessionId, setSessionId] = useState(initialSession ? Number(initialSession.id) : null);
  const [status, setStatus] = useState(initialSession ? initialSession.status : 'bot');
  const [messages, setMessages] = useState(() => {
    if (restoredMessages.length > 0) return restoredMessages;
    return [{ id: 'welcome', sender: 'bot', text: defaultGreeting }];
  });
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState('');
  const [streamOnline, setStreamOnline] = useState(false);
  const [phase, setPhase] = useState(initialDraftState && initialDraftState.phase ? initialDraftState.phase : 'collecting');
  const [pendingField, setPendingField] = useState(initialDraftState && initialDraftState.pendingField ? initialDraftState.pendingField : null);
  const [collectedFields, setCollectedFields] = useState(initialDraftFields);
  const [pendingDisambiguation, setPendingDisambiguation] = useState(
    initialDraftState && initialDraftState.pendingDisambiguation ? initialDraftState.pendingDisambiguation : null
  );
  const [disambiguationQueue, setDisambiguationQueue] = useState(
    initialDraftState && Array.isArray(initialDraftState.disambiguationQueue)
      ? initialDraftState.disambiguationQueue
      : []
  );
  const [preOfferState, setPreOfferState] = useState(initialDraftState && initialDraftState.preOfferState ? initialDraftState.preOfferState : null);

  const lastSeenIdRef = useRef(maxMessageId(restoredMessages));
  const seenIdsRef = useRef(createSeenIdSet(restoredMessages));
  const streamRef = useRef(null);
  // 봇 인계 재처리 신호를 받을 때 쓸 최신 handleSend(아래에서 매 렌더 갱신).
  const handleSendRef = useRef(null);
  const troubleStreakRef = useRef(0);
  const vehicleNumberFailCountRef = useRef(0);

  const statusLabel = STATUS_LABEL[status] || status;
  const badgeClass = STATUS_BADGE[status] || 'gray';
  const hasDraft = !!initialDraft;

  const phaseLabel = phase === 'confirming'
    ? '등록 확인'
    : phase === 'choose_field'
      ? '수정 항목 선택'
      : phase === 'choose_address_candidate'
        ? '주소 후보 선택'
        : phase === 'offer_agent'
          ? '상담원 연결 제안'
      : pendingField
        ? ('재입력: ' + pendingField)
        : '정보 수집';

  const canSend = useMemo(() => {
    return !isSending && input.trim().length > 0;
  }, [input, isSending]);

  function pushMessage(sender, text, id, options) {
    const opts = options || {};
    setMessages((prev) => prev.concat([{
      id: id || Date.now() + '-' + prev.length,
      sender,
      text,
      pending: !!opts.pending,
    }]));
  }

  function mergeServerMessages(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    setMessages((prev) => {
      const next = prev.slice();
      items.forEach((item) => {
        const incoming = toIncomingMessage(item);
        if (!incoming) return;
        if (seenIdsRef.current.has(incoming.id)) return;

        const pendingIdx = next.findIndex((m) => m.pending && m.sender === incoming.sender && m.text === incoming.text);
        if (pendingIdx >= 0) next.splice(pendingIdx, 1);

        next.push({ id: incoming.id, sender: incoming.sender, text: incoming.text, pending: false });
        seenIdsRef.current.add(incoming.id);
        if (incoming.id > lastSeenIdRef.current) lastSeenIdRef.current = incoming.id;
      });
      return next;
    });
  }

  async function catchUpMessages(sid) {
    if (!sid) return;
    const data = await fetchJson('/chat/' + sid + '/messages?since=' + String(lastSeenIdRef.current || 0), {
      method: 'GET',
    });
    if (data.status) setStatus(data.status);
    if (Array.isArray(data.messages) && data.messages.length > 0) {
      mergeServerMessages(data.messages);
    }
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    const created = await fetchJson('/chat/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const nextId = Number(created.sessionId);
    setSessionId(nextId);
    setStatus('bot');
    return nextId;
  }

  async function saveBotTurn(sid, payload) {
    const botSaved = await fetchJson('/chat/' + sid + '/bot-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (botSaved.status) setStatus(botSaved.status);
    await catchUpMessages(sid);
    return botSaved;
  }

  async function replyWithMessage(sid, message, options) {
    const opts = options || {};
    const draftState = opts.draftState || {
      source: 'next-ai-intake-client',
      phase,
      pendingField,
      fields: collectedFields,
      pendingDisambiguation,
      disambiguationQueue,
      preOfferState,
    };
    const saved = await saveBotTurn(sid, {
      message,
      needsAgent: !!opts.needsAgent,
      requestedFeature: opts.requestedFeature || null,
      draftState,
    });
    if (!streamOnline) {
      const fallback = saved.message || message;
      if (fallback) pushMessage('bot', fallback);
    }
    return saved;
  }

  function makeDraftState(overrides) {
    return Object.assign({
      source: 'next-ai-intake-client',
      phase,
      pendingField,
      fields: collectedFields,
      pendingDisambiguation,
      disambiguationQueue,
      preOfferState,
    }, overrides || {});
  }

  async function classifyPhaseReplyFallback(text, phaseName, candidates) {
    try {
      return await fetchJson('/orders/ai-intake/classify-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, phase: phaseName, candidates: candidates || [] }),
      });
    } catch {
      return { action: 'unclear' };
    }
  }

  async function offerAgentConnection(sid) {
    if (phase === 'offer_agent') return;
    const resume = {
      phase,
      pendingField,
      pendingDisambiguation,
      disambiguationQueue,
    };
    setPreOfferState(resume);
    setPhase('offer_agent');
    await replyWithMessage(sid, '더 빠른 처리를 위해 상담원 연결을 해드릴까요? (네 / 아니요)', {
      draftState: {
        source: 'next-ai-intake-client',
        phase: 'offer_agent',
        pendingField,
        fields: collectedFields,
        pendingDisambiguation,
        disambiguationQueue,
        preOfferState: resume,
      },
    });
  }

  async function noteTrouble(sid) {
    troubleStreakRef.current += 1;
    if (troubleStreakRef.current >= TROUBLE_STREAK_LIMIT) {
      troubleStreakRef.current = 0;
      await offerAgentConnection(sid);
      return true;
    }
    return false;
  }

  function noteProgress() {
    troubleStreakRef.current = 0;
    vehicleNumberFailCountRef.current = 0;
  }

  async function closeCurrentSessionForNewOrder(sid) {
    await fetchJson('/chat/' + sid + '/bot-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '이전 상담 요청은 종료하고 새 오더 접수로 이어가겠습니다.',
        closeSession: true,
      }),
    });
  }

  async function createFreshSession() {
    const created = await fetchJson('/chat/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const nextId = Number(created.sessionId);
    setSessionId(nextId);
    setStatus('bot');
    setPhase('collecting');
    setPendingField(null);
    setPendingDisambiguation(null);
    setDisambiguationQueue([]);
    setPreOfferState(null);
    setCollectedFields({});
    return nextId;
  }

  // pendingFieldOverride: 상담원 연결 제안을 접고 곧바로 답을 처리할 때 쓴다. React 상태
  // 갱신(setPendingField)은 즉시 반영되지 않아서, 복구된 값을 인자로 넘겨야 이번 호출이
  // 옛 pendingField를 보고 엉뚱하게 처리하는 것을 막을 수 있다.
  async function handleCollectingPhase(sid, text, pendingFieldOverride) {
    const activePendingField = pendingFieldOverride !== undefined ? pendingFieldOverride : pendingField;
    if (activePendingField === 'origin_contact' || activePendingField === 'destination_contact') {
      const directPhone = extractPhone(text);
      if (directPhone) {
        const nextFields = mergeOrderFields(collectedFields, { [activePendingField]: directPhone });
        setCollectedFields(nextFields);
        setPendingField(null);
        setPhase('confirming');
        noteProgress();
        if (typeof onOrderPrefill === 'function') onOrderPrefill(nextFields);
        const msg = '연락처를 ' + directPhone + '(으)로 확인했습니다.\n\n'
          + buildOrderSummary(nextFields)
          + '\n\n위 내용으로 등록할까요? (네 / 수정)';
        await replyWithMessage(sid, msg, {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({
            phase: 'confirming',
            pendingField: null,
            fields: nextFields,
          }),
        });
        return;
      }
    }

    if (activePendingField === 'vehicle_number') {
      const compact = String(text || '').replace(/\s+/g, '');
      if (VEHICLE_NUMBER_SKIP_RE.test(compact)) {
        const nextFields = mergeOrderFields(collectedFields, { vehicle_number: '' });
        setCollectedFields(nextFields);
        setPendingField(null);
        setPhase('confirming');
        noteProgress();
        if (typeof onOrderPrefill === 'function') {
          onOrderPrefill({ ...nextFields, __clearFields: ['vehicle_number'] });
        }
        const msg = '차량번호는 출발지에서 다시 확인하겠습니다.\n\n' + buildOrderSummary(nextFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
        await replyWithMessage(sid, msg, {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({
            phase: 'confirming',
            pendingField: null,
            fields: nextFields,
          }),
        });
        return;
      }

      if (VEHICLE_NUMBER_RE.test(compact)) {
        const nextFields = mergeOrderFields(collectedFields, { vehicle_number: compact });
        setCollectedFields(nextFields);
        setPendingField(null);
        setPhase('confirming');
        noteProgress();
        if (typeof onOrderPrefill === 'function') onOrderPrefill(nextFields);
        const msg = '차량번호는 ' + compact + '(으)로 확인했습니다.\n\n' + buildOrderSummary(nextFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
        await replyWithMessage(sid, msg, {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({
            phase: 'confirming',
            pendingField: null,
            fields: nextFields,
          }),
        });
        return;
      }

      vehicleNumberFailCountRef.current += 1;
      if (vehicleNumberFailCountRef.current >= 2) {
        vehicleNumberFailCountRef.current = 0;
        const nextFields = mergeOrderFields(collectedFields, { vehicle_number: '' });
        setCollectedFields(nextFields);
        setPendingField(null);
        setPhase('confirming');
        if (typeof onOrderPrefill === 'function') {
          onOrderPrefill({ ...nextFields, __clearFields: ['vehicle_number'] });
        }
        const failMsg = '차량번호 형식을 확인하기 어려워 등록하지 않았습니다.\n\n' + buildOrderSummary(nextFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
        await replyWithMessage(sid, failMsg, {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({
            phase: 'confirming',
            pendingField: null,
            fields: nextFields,
          }),
        });
        return;
      }

      if (await noteTrouble(sid)) return;
      await replyWithMessage(sid, '차량번호 형식이 올바르지 않습니다. 예: 12가3456', {
        needsAgent: false,
        requestedFeature: null,
      });
      return;
    }

    if (activePendingField === 'memo_customer') {
      const trimmed = String(text || '').trim();
      const nextMemo = ADDITIONAL_REQUEST_NONE_RE.test(trimmed) ? '' : trimmed;
      const nextFields = mergeOrderFields(collectedFields, { memo_customer: nextMemo });
      setCollectedFields(nextFields);
      setPendingField(null);
      setPhase('confirming');
      noteProgress();
      if (typeof onOrderPrefill === 'function') {
        if (nextMemo) onOrderPrefill(nextFields);
        else onOrderPrefill({ ...nextFields, __clearFields: ['memo_customer'] });
      }
      const msg = (nextMemo ? ('요청사항을 반영했습니다.\n\n') : '') + buildOrderSummary(nextFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
      await replyWithMessage(sid, msg, {
        needsAgent: false,
        requestedFeature: null,
        draftState: makeDraftState({
          phase: 'confirming',
          pendingField: null,
          fields: nextFields,
        }),
      });
      return;
    }

    // 접수 대화 판단을 서버로 옮긴 경로(Stage A, 탁송만) — 기능 플래그가 꺼져 있으면(기본값)
    // 이 분기는 아예 실행되지 않고 지금까지와 완전히 동일하게 동작한다. 이 파일에는 프리미엄/
    // 일일기사 카테고리 자체가 없어(orderCategory 개념이 없다) EJS 위젯과 달리 별도 제외
    // 조건이 필요 없다 — handleCollectingPhase에 들어오는 모든 대화가 대상이다.
    let reuseClassified = null;
    if (serverTurnEnabled) {
      const turnResult = await fetchJson('/chat/' + sid + '/intake-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }).catch(() => ({ ok: false, fallthrough: true }));

      if (turnResult && turnResult.fallthrough === false) {
        // 서버가 이미 chat_messages에 답을 저장하고 SSE로 중계했다 — catchUpMessages가
        // dedupe(seenIdsRef)로 안전하게 그 메시지를 화면에 반영한다. phase는 그대로
        // 'collecting'에 둔다 — 확인/주소선택 상태는 이 파일의 phase가 아니라 서버의
        // intake_slots_json이 들고 있다.
        if (turnResult.status) setStatus(turnResult.status);
        // 서버가 이번 턴에 필수 항목을 다 채웠으면(주소 확인 대기 포함) 우측 폼도 반영한다.
        // 이게 빠져 있으면 판단이 서버로 넘어간 뒤로 이 폼이 챗봇 파악 내용을 전혀 못
        // 보여줬다(실사용 지적, 2026-08-11) — 클라이언트 자체 파싱 경로(아래 collectedFields
        // 기반 분기들)만 onOrderPrefill을 부르고 있었다.
        if (turnResult.intake && typeof onOrderPrefill === 'function') onOrderPrefill(turnResult.intake);
        await catchUpMessages(sid);
        return;
      }
      // fallthrough — 서버가 다루지 않은 요청(faq/unsupported 등)이니 기존 경로로 넘긴다.
      // 턴 엔진이 이미 분류한 결과가 있으면 parse에 넘겨 Gemini 재분류를 아낀다(응답 지연 절반).
      reuseClassified = (turnResult && turnResult.classified) || null;
    }

    const parseData = await fetchJson('/orders/ai-intake/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // sessionId는 FAQ 검색 문맥 보강(직전 사용자 질문 참고)에만 쓰인다(lib/knowledgeSearch.js).
      body: JSON.stringify({ text, pendingField: activePendingField || null, classified: reuseClassified, sessionId }),
    });

    if (isAgentRequest(text) || parseData.intent === 'unsupported') {
      await replyWithMessage(sid, null, {
        needsAgent: true,
        requestedFeature: parseData.requestedFeature || '상담원 연결',
      });
      setPhase('collecting');
      setPendingField(null);
      return;
    }

    if (!isOrderIntent(parseData)) {
      const botDraft = resolveBotDraft(parseData);
      await replyWithMessage(sid, botDraft.message, {
        needsAgent: !!botDraft.needsAgent,
        requestedFeature: botDraft.requestedFeature || null,
      });
      return;
    }

    const patchFields = pickOrderFields(parseData);
    if (activePendingField) {
      const pendingValue = activePendingField === 'reserved_date'
        ? (patchFields.reserved_date || patchFields.reserved_time)
        : patchFields[activePendingField];
      if (!pendingValue) {
        if (await noteTrouble(sid)) return;
        const retryPrompt = PENDING_FIELD_PROMPTS[activePendingField] || (activePendingField + ' 값을 이해하지 못했습니다. 다시 입력해주세요.');
        await replyWithMessage(sid, retryPrompt, {
          draftState: {
            source: 'next-ai-intake-client',
            phase: 'collecting',
            activePendingField,
            fields: collectedFields,
            pendingDisambiguation,
            disambiguationQueue,
            preOfferState,
          },
        });
        return;
      }
    }

    const mergedFields = mergeOrderFields(collectedFields, patchFields);
    setCollectedFields(mergedFields);
    setPendingField(null);

    const disambiguations = extractDisambiguations(parseData);
    if (disambiguations.length > 0) {
      const first = disambiguations[0];
      const queue = disambiguations.slice(1);
      setPendingDisambiguation(first);
      setDisambiguationQueue(queue);
      setPhase('choose_address_candidate');
      noteProgress();
      await replyWithMessage(sid, candidateListText(first), {
        draftState: {
          source: 'next-ai-intake-client',
          phase: 'choose_address_candidate',
          pendingField: null,
          fields: mergedFields,
          pendingDisambiguation: first,
          disambiguationQueue: queue,
          preOfferState,
        },
      });
      return;
    }

    setPendingDisambiguation(null);
    setDisambiguationQueue([]);
    setPhase('confirming');
    noteProgress();

    if (typeof onOrderPrefill === 'function') {
      onOrderPrefill(mergedFields);
    }

    const confirmText = buildOrderSummary(mergedFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
    await replyWithMessage(sid, confirmText, {
      needsAgent: false,
      requestedFeature: null,
      draftState: {
        source: 'next-ai-intake-client',
        phase: 'confirming',
        pendingField: null,
        fields: mergedFields,
        pendingDisambiguation: null,
        disambiguationQueue: [],
        preOfferState,
      },
    });
  }

  async function handleConfirmingPhase(sid, text) {
    if (isAgentRequest(text)) {
      await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
      return;
    }
    if (isAffirmative(text)) {
      setPhase('collecting');
      setPendingField(null);
      await replyWithMessage(
        sid,
        '좋습니다. 아래 오더 폼에서 내용을 확인하고 "오더 등록" 버튼을 눌러 접수를 완료해주세요.',
        { needsAgent: false, requestedFeature: null }
      );
      return;
    }
    if (isNegative(text)) {
      setPhase('choose_field');
      setPendingField(null);
      await replyWithMessage(
        sid,
        '어느 항목을 수정할까요?\n출발지 주소 / 출발지 연락처 / 도착지 주소 / 도착지 연락처 / 예약일시 / 차종 / 차량번호 / 기사 전달사항',
        {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({ phase: 'choose_field', pendingField: null }),
        }
      );
      return;
    }

    const classified = await classifyPhaseReplyFallback(text, 'confirming');
    if (classified.action === 'agent') {
      await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
      return;
    }
    if (classified.action === 'yes') {
      setPhase('collecting');
      setPendingField(null);
      await replyWithMessage(
        sid,
        '좋습니다. 아래 오더 폼에서 내용을 확인하고 "오더 등록" 버튼을 눌러 접수를 완료해주세요.',
        { needsAgent: false, requestedFeature: null }
      );
      return;
    }
    if (classified.action === 'no') {
      setPhase('choose_field');
      setPendingField(null);
      await replyWithMessage(
        sid,
        '어느 항목을 수정할까요?\n출발지 주소 / 출발지 연락처 / 도착지 주소 / 도착지 연락처 / 예약일시 / 차종 / 차량번호 / 기사 전달사항',
        {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({ phase: 'choose_field', pendingField: null }),
        }
      );
      return;
    }

    if (await noteTrouble(sid)) return;
    await replyWithMessage(sid, '등록하려면 "네", 수정하려면 "수정"이라고 입력해주세요.', {
      needsAgent: false,
      requestedFeature: null,
    });
  }

  async function handleChooseFieldPhase(sid, text) {
    if (isAgentRequest(text)) {
      await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
      return;
    }
    const field = findFieldByKeyword(text);
    if (!field) {
      const classified = await classifyPhaseReplyFallback(text, 'choose_field');
      if (classified.action === 'agent') {
        await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
        return;
      }
      if (classified.action === 'field' && classified.field) {
        const matched = FIELD_KEYWORDS.find((f) => f.id === classified.field);
        if (matched) {
          setPendingField(matched.id);
          setPhase('collecting');
          noteProgress();
          await replyWithMessage(sid, matched.label + '를 새로 입력해주세요.', {
            needsAgent: false,
            requestedFeature: null,
            draftState: makeDraftState({ phase: 'collecting', pendingField: matched.id }),
          });
          return;
        }
      }
      if (classified.action === 'none') {
        setPhase('confirming');
        const confirmText = buildOrderSummary(collectedFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
        await replyWithMessage(sid, confirmText, {
          needsAgent: false,
          requestedFeature: null,
          draftState: makeDraftState({ phase: 'confirming', pendingField: null }),
        });
        return;
      }

      if (await noteTrouble(sid)) return;
      await replyWithMessage(
        sid,
        '수정할 항목을 이해하지 못했습니다. 예: "출발지 주소 수정", "차량번호 수정"',
        { needsAgent: false, requestedFeature: null }
      );
      return;
    }
    setPendingField(field.id);
    setPhase('collecting');
    noteProgress();
    await replyWithMessage(sid, (PENDING_FIELD_PROMPTS[field.id] || (field.label + '를 새로 입력해주세요.')),
      {
        needsAgent: false,
        requestedFeature: null,
        draftState: makeDraftState({ phase: 'collecting', pendingField: field.id }),
      });
  }

  async function handleDisambiguationPhase(sid, text) {
    if (isAgentRequest(text)) {
      await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
      return;
    }

    const dis = pendingDisambiguation;
    if (!dis || !Array.isArray(dis.candidates) || dis.candidates.length < 2) {
      setPendingDisambiguation(null);
      setDisambiguationQueue([]);
      setPhase('confirming');
      const fallbackConfirm = buildOrderSummary(collectedFields) + '\n\n위 내용으로 등록할까요? (네 / 수정)';
      await replyWithMessage(sid, fallbackConfirm, {
        needsAgent: false,
        requestedFeature: null,
        draftState: makeDraftState({ phase: 'confirming', pendingField: null, pendingDisambiguation: null, disambiguationQueue: [] }),
      });
      return;
    }

    const raw = String(text || '').trim();
    let picked = null;
    if (/^1\s*(번|\.|\))?$/i.test(raw) || /^첫/.test(raw)) picked = dis.candidates[0];
    if (!picked && (/^2\s*(번|\.|\))?$/i.test(raw) || /^(둘|두\s?번)/.test(raw))) picked = dis.candidates[1];
    if (!picked) {
      picked = dis.candidates.find((c) => raw.length >= 2 && String(c.label || '').includes(raw)) || null;
    }

    if (!picked) {
      const classified = await classifyPhaseReplyFallback(
        text,
        'choose_address_candidate',
        dis.candidates.map((c) => c.label)
      );
      if (classified.action === 'agent') {
        await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
        return;
      }
      if (classified.action === 'choice1') picked = dis.candidates[0];
      if (classified.action === 'choice2') picked = dis.candidates[1];
    }

    if (!picked) {
      if (await noteTrouble(sid)) return;
      await replyWithMessage(sid, '1번 또는 2번으로 답해주세요.', { needsAgent: false, requestedFeature: null });
      return;
    }

    const nextFields = mergeOrderFields(collectedFields, { [dis.fieldId]: picked.value || picked.label });
    setCollectedFields(nextFields);
    if (typeof onOrderPrefill === 'function') onOrderPrefill(nextFields);

    if (disambiguationQueue.length > 0) {
      const next = disambiguationQueue[0];
      const remain = disambiguationQueue.slice(1);
      setPendingDisambiguation(next);
      setDisambiguationQueue(remain);
      noteProgress();
      await replyWithMessage(sid, `${dis.label}는 '${picked.label}'로 확인했습니다.\n\n${candidateListText(next)}`, {
        needsAgent: false,
        requestedFeature: null,
        draftState: {
          source: 'next-ai-intake-client',
          phase: 'choose_address_candidate',
          pendingField: null,
          fields: nextFields,
          pendingDisambiguation: next,
          disambiguationQueue: remain,
          preOfferState,
        },
      });
      return;
    }

    setPendingDisambiguation(null);
    setDisambiguationQueue([]);
    setPhase('confirming');
    noteProgress();
    const confirmText = `${dis.label}는 '${picked.label}'로 확인했습니다.\n\n${buildOrderSummary(nextFields)}\n\n위 내용으로 등록할까요? (네 / 수정)`;
    await replyWithMessage(sid, confirmText, {
      needsAgent: false,
      requestedFeature: null,
      draftState: {
        source: 'next-ai-intake-client',
        phase: 'confirming',
        pendingField: null,
        fields: nextFields,
        pendingDisambiguation: null,
        disambiguationQueue: [],
        preOfferState,
      },
    });
  }

  async function handleOfferAgentPhase(sid, text) {
    if (isAffirmative(text) || isAgentRequest(text)) {
      setPhase('collecting');
      setPendingField(null);
      setPendingDisambiguation(null);
      setDisambiguationQueue([]);
      setPreOfferState(null);
      await replyWithMessage(sid, null, { needsAgent: true, requestedFeature: '상담원 연결' });
      return;
    }

    if (isNegative(text) || /^(괜찮|계속|아니)/i.test(String(text || '').trim())) {
      const resume = preOfferState || {
        phase: 'collecting',
        pendingField: null,
        pendingDisambiguation: null,
        disambiguationQueue: [],
      };
      setPreOfferState(null);
      setPhase(resume.phase || 'collecting');
      setPendingField(resume.activePendingField || null);
      setPendingDisambiguation(resume.pendingDisambiguation || null);
      setDisambiguationQueue(Array.isArray(resume.disambiguationQueue) ? resume.disambiguationQueue : []);

      let followUp = '네, 계속 진행하겠습니다.';
      if (resume.phase === 'confirming') {
        followUp += '\n등록하려면 "네", 수정하려면 "수정"이라고 입력해주세요.';
      } else if (resume.phase === 'choose_field') {
        followUp += '\n수정할 항목을 말씀해주세요.';
      } else if (resume.phase === 'choose_address_candidate' && resume.pendingDisambiguation) {
        followUp += '\n' + candidateListText(resume.pendingDisambiguation);
      } else if (resume.activePendingField) {
        followUp += '\n' + resume.activePendingField + ' 값을 다시 입력해주세요.';
      }

      await replyWithMessage(sid, followUp, {
        needsAgent: false,
        requestedFeature: null,
        draftState: makeDraftState({
          phase: resume.phase || 'collecting',
          pendingField: resume.activePendingField || null,
          pendingDisambiguation: resume.pendingDisambiguation || null,
          disambiguationQueue: Array.isArray(resume.disambiguationQueue) ? resume.disambiguationQueue : [],
          preOfferState: null,
        }),
      });
      return;
    }

    // "네/아니요"가 아니라 원래 묻던 질문의 답을 곧바로 보낸 경우다 — 되묻지 말고 그 답을 받는다.
    //
    // 2026-08-14 세션 923 실측(EJS 접수장): 잘못된 차량번호("48조94233") 뒤에 이 제안이 떴는데
    // 고객은 제안에 답하는 대신 정정한 번호("123가4949")를 보냈다. 그 입력이 아래 되묻기로
    // 버려져서 "아니오"를 한 번 더 치고 번호를 다시 입력해야 했다 — 3턴이 낭비됐다.
    // 같은 결함이 이 화면에도 있어 함께 고친다(public/js/ai-intake.js와 같은 규칙).
    //
    // 형식이 확실한 필드에서만 이 지름길을 쓴다. 아무 텍스트나 답으로 받으면, 이 제안을 띄운
    // 원인(연속 실패·화남)이 그대로 반복돼 제안과 실패가 무한히 오갈 수 있다.
    const resumeField = (preOfferState || {}).pendingField || null;
    if (resumeField === 'vehicle_number'
        && VEHICLE_NUMBER_RE.test(String(text || '').replace(/\s+/g, ''))) {
      const resume = preOfferState || {};
      setPreOfferState(null);
      setPhase(resume.phase || 'collecting');
      setPendingField(resumeField);
      setPendingDisambiguation(resume.pendingDisambiguation || null);
      setDisambiguationQueue(Array.isArray(resume.disambiguationQueue) ? resume.disambiguationQueue : []);
      // 상태 갱신은 즉시 반영되지 않으므로 복구된 필드를 인자로 넘긴다.
      await handleCollectingPhase(sid, text, resumeField);
      return;
    }

    await replyWithMessage(sid, '상담원 연결이 필요하시면 "네", 계속 진행하시려면 "아니요"라고 답해주세요.', {
      needsAgent: false,
      requestedFeature: null,
    });
  }

  // replayText가 오면 "이미 화면과 DB에 남아 있는 고객 발화를 봇이 다시 처리"하는 흐름이다
  // (상담원 무응답으로 봇에게 응대가 넘어온 경우 — 서버가 SSE로 신호를 준다).
  // 말풍선을 새로 그리거나 다시 저장하지 않는다. 중복으로 남는다.
  // 버튼 onClick으로 들어오는 이벤트 객체와 구분해야 해서 문자열인지 확인한다.
  // useEffect의 SSE 콜백은 sessionId에만 의존해 다시 붙으므로, 그대로 handleSend를 참조하면
  // 초기 렌더의 phase를 캡처한 낡은 함수를 부르게 된다. 매 렌더 최신 것을 ref에 걸어둔다.
  handleSendRef.current = handleSend;

  async function handleSend(replayText) {
    const isReplay = typeof replayText === 'string' && !!replayText.trim();
    const text = isReplay ? replayText.trim() : input.trim();
    if (!text) return;
    if (!isReplay && isSending) return;

    setIsSending(true);
    setError('');
    if (!isReplay) {
      setInput('');
      pushMessage('user', text, null, { pending: true });
    }

    try {
      let sid = await ensureSession();

      if (!isReplay) {
        if (status === 'needs_agent' && looksLikeNewOrderWhileWaiting(text)) {
          await closeCurrentSessionForNewOrder(sid);
          sid = await createFreshSession();
        }

        await fetchJson('/chat/' + sid + '/user-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        await catchUpMessages(sid);
      }

      if (phase === 'offer_agent') {
        await handleOfferAgentPhase(sid, text);
      } else if (phase === 'confirming') {
        await handleConfirmingPhase(sid, text);
      } else if (phase === 'choose_address_candidate') {
        await handleDisambiguationPhase(sid, text);
      } else if (phase === 'choose_field') {
        await handleChooseFieldPhase(sid, text);
      } else {
        await handleCollectingPhase(sid, text);
      }
    } catch (e) {
      setError(e.message || '메시지 전송에 실패했습니다.');
      pushMessage('bot', '요청 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setIsSending(false);
    }
  }

  useEffect(() => {
    if (!sessionId) return undefined;

    let disposed = false;
    let pollTimer = null;

    function closeStream() {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
    }

    function connectStream() {
      closeStream();
      const es = new EventSource('/chat/' + sessionId + '/stream');
      streamRef.current = es;

      es.onopen = () => {
        if (disposed) return;
        setStreamOnline(true);
      };

      es.onmessage = (event) => {
        if (disposed) return;
        try {
          const payload = JSON.parse(event.data);
          // 상담원 무응답으로 봇에게 응대가 넘어왔다 — 고객이 이미 한 말을 다시 시키지 않고
          // 이 창이 그 문장으로 봇 경로를 한 번 태운다.
          if (payload && payload.type === 'bot_handover_replay') {
            if (payload.text && handleSendRef.current) handleSendRef.current(payload.text);
            return;
          }
          // 그 밖의 제어성 payload(read_receipt 등)는 말풍선이 아니므로 무시한다.
          if (payload && payload.type) return;
          mergeServerMessages([payload]);
        } catch (err) {
          // ignore malformed payload
        }
      };

      es.onerror = () => {
        if (disposed) return;
        setStreamOnline(false);
      };
    }

    connectStream();
    catchUpMessages(sessionId).catch(() => {});
    pollTimer = setInterval(() => {
      catchUpMessages(sessionId).catch(() => {});
    }, 7000);

    return () => {
      disposed = true;
      setStreamOnline(false);
      if (pollTimer) clearInterval(pollTimer);
      closeStream();
    };
  }, [sessionId]);

  return (
    <div className="card ai-chat-card" style={{ height: 'auto', minHeight: 520 }}>
      <div className="ai-chat-header">
        <span className="ai-chat-title">🤖 AI 챗봇 + 👤 상담원 채팅 (Next)</span>
        <div className={'ai-chat-connection ' + (streamOnline ? 'online' : 'offline')} aria-live="polite">
          <span className="ai-chat-connection-dot" aria-hidden="true"></span>
          <span className="ai-chat-connection-text">{streamOnline ? '실시간 연결중' : '재연결중'}</span>
        </div>
      </div>

      <div className="session-meta" style={{ marginBottom: 10 }}>
        <span>세션 ID: <b>{sessionId || '새 세션'}</b></span>
        <span>상태: <b><span className={'badge ' + badgeClass}>{statusLabel}</span></b></span>
        <span>복원 Draft: <b>{hasDraft ? '있음' : '없음'}</b></span>
        <span>Phase: <b>{phaseLabel}</b></span>
      </div>

      <div className="ai-chat-messages" style={{ minHeight: 340, maxHeight: 480 }}>
        {messages.map((message) => {
          const bubbleClass =
            message.sender === 'user'
              ? 'ai-chat-bubble ai-user'
              : message.sender === 'agent'
                ? 'ai-chat-bubble ai-agent'
                : 'ai-chat-bubble ai-bot';

          return (
            <div key={message.id} className={bubbleClass} style={{ maxWidth: '100%' }}>
              {message.sender === 'agent' && <span className="bubble-label">상담원</span>}
              <div>{message.sender === 'user' ? message.text : renderChatText(message.text)}</div>
            </div>
          );
        })}
      </div>

      {error && <div className="chat-inline-error" style={{ marginBottom: 8 }}>{error}</div>}

      <div className="ai-chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="예) 내일 오후 4시 판교역에서 강남역까지 차량 이동 예약"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={isSending}
        ></textarea>
        <button
          type="button"
          className="ai-send-btn"
          onClick={handleSend}
          disabled={!canSend}
          aria-label="메시지 전송"
          title="메시지 전송"
        >
          {isSending ? '...' : '↑'}
        </button>
      </div>
    </div>
  );
}
