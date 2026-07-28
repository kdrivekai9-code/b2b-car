// 상담원 호출 알림음 재생 로직 — agent-presence.js(실제 알림 발생 시)와 push_settings.ejs(설정/미리듣기)가
// 공유한다. 설정은 이 브라우저에만 저장(localStorage) — 이 프로젝트의 기존 관례대로 서버에는 남기지 않는다.
window.AgentAlertSound = (function () {
  var STORAGE_ENABLED = 'agentAlert.enabled.v1';
  var STORAGE_TONE = 'agentAlert.tone.v1';
  var audioCtx = null;

  function isEnabled() {
    var v = localStorage.getItem(STORAGE_ENABLED);
    return v === null ? true : v === '1';
  }
  function setEnabled(on) { localStorage.setItem(STORAGE_ENABLED, on ? '1' : '0'); }
  function getTone() { return localStorage.getItem(STORAGE_TONE) || 'beep'; }
  function setTone(tone) { localStorage.setItem(STORAGE_TONE, tone); }

  // 브라우저 자동재생 정책 때문에 실제 사용자 제스처(클릭/키입력) 시점에 미리 만들어둬야
  // 나중에 SSE 알림처럼 제스처 없이 재생을 시도할 때도 소리가 실제로 난다.
  function unlock() {
    if (audioCtx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* noop */ }
  }
  ['click', 'keydown', 'touchstart'].forEach(function (evt) {
    document.addEventListener(evt, unlock, { once: true, passive: true });
  });

  function beepTone(ctx, freq, start, dur, peak) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(peak || 0.35, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur + 0.05);
  }

  var TONES = {
    beep: function (ctx) { [0, 0.18].forEach(function (t) { beepTone(ctx, 880, t, 0.16); }); },
    chime: function (ctx) { beepTone(ctx, 660, 0, 0.22, 0.3); beepTone(ctx, 880, 0.16, 0.3, 0.3); },
    urgent: function (ctx) { [0, 0.14, 0.28].forEach(function (t) { beepTone(ctx, 1046, t, 0.1, 0.4); }); },
  };

  function play(toneOverride) {
    unlock();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var fn = TONES[toneOverride || getTone()] || TONES.beep;
    try { fn(audioCtx); } catch (e) { /* 재생 실패는 조용히 무시 */ }
  }

  return { isEnabled: isEnabled, setEnabled: setEnabled, getTone: getTone, setTone: setTone, play: play };
})();
