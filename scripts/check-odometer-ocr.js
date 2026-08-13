#!/usr/bin/env node
// 계기판 주행거리 인식의 판정 로직 — 제미나이/네트워크 없이 확인한다.
//
// 왜 필요한가: 잘못 읽은 숫자를 고객에게 통보하는 것이 아무것도 안 보내는 것보다 나쁘다.
// "못 읽었다"를 0km로 바꿔버리거나, 트립미터 숫자를 적산거리로 착각하는 것을 여기서 막는다.
//
// 사용법: node scripts/check-odometer-ocr.js
const ocr = require('../lib/odometerOcr');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log(`       기대: ${JSON.stringify(expected)}\n       실제: ${JSON.stringify(actual)}`);
}

// 인식 결과를 흉내내는 가짜 제미나이/다운로드.
function fakeReader({ odometerKm, confidence, throws }) {
  return {
    fetchImage: async () => ({ ok: true, buffer: Buffer.from('x'), contentType: 'image/jpeg' }),
    generate: async () => {
      if (throws) throw new Error(throws);
      return { odometerKm, confidence };
    },
  };
}

(async () => {
  console.log('[값의 타당성]');
  check('정상값', ocr.plausibleKm(12345), 12345);
  check('소수점은 반올림', ocr.plausibleKm(12345.4), 12345);
  check('0은 값 없음', ocr.plausibleKm(0), null);
  check('음수는 값 없음', ocr.plausibleKm(-5), null);
  check('null은 값 없음', ocr.plausibleKm(null), null);
  check('숫자가 아니면 값 없음', ocr.plausibleKm('abc'), null);
  check('상한을 넘으면 값 없음', ocr.plausibleKm(ocr.MAX_PLAUSIBLE_KM + 1), null);

  console.log('[총 주행거리 계산]');
  check('완료 − 시작', ocr.computeDistance(12345, 12470), 125);
  check('같으면 0(정지 상태로 접수된 건)', ocr.computeDistance(12345, 12345), 0);
  // 계기판 교체나 오인식이면 뒤집힌다 — 음수 거리를 통보하면 안 된다.
  check('뒤집히면 값 없음', ocr.computeDistance(12470, 12345), null);
  check('한쪽이 없으면 값 없음', ocr.computeDistance(12345, null), null);
  check('둘 다 없으면 값 없음', ocr.computeDistance(null, null), null);
  // 한 건에 3000km는 국내 탁송에서 나올 수 없다 — 두 사진이 다른 차량일 가능성이 높다.
  check('한 건 상한을 넘으면 값 없음', ocr.computeDistance(1000, 1000 + ocr.MAX_TRIP_KM + 1), null);
  check('상한 경계는 통과', ocr.computeDistance(1000, 1000 + ocr.MAX_TRIP_KM), ocr.MAX_TRIP_KM);

  console.log('[사진 한 장 읽기]');
  let r = await ocr.readOdometerKm('x.jpg', fakeReader({ odometerKm: 12345, confidence: 0.95 }));
  check('확신도가 높으면 값을 쓴다', r.km, 12345);

  r = await ocr.readOdometerKm('x.jpg', fakeReader({ odometerKm: 12345, confidence: 0.3 }));
  check('확신도가 낮으면 버린다', r.km, null);

  r = await ocr.readOdometerKm('x.jpg', fakeReader({ odometerKm: 0, confidence: 0.99 }));
  check('0km는 버린다(못 읽은 것과 구분이 안 된다)', r.km, null);

  r = await ocr.readOdometerKm('x.jpg', fakeReader({ odometerKm: null, confidence: 0 }));
  check('계기판이 없으면 버린다', r.km, null);

  r = await ocr.readOdometerKm('x.jpg', fakeReader({ throws: 'Vertex 오류' }));
  check('모델 호출이 실패해도 예외를 던지지 않는다', r.km, null);
  check('실패 사유를 남긴다', /Vertex 오류/.test(r.reason || ''), true);

  r = await ocr.readOdometerKm('x.jpg', {
    fetchImage: async () => ({ ok: false, error: '사진을 가져오지 못했습니다 (404)' }),
    generate: async () => { throw new Error('불려서는 안 된다'); },
  });
  check('링크가 만료되면 모델을 부르지 않는다', r.km, null);
  check('다운로드 실패 사유를 남긴다', /404/.test(r.reason || ''), true);
  // 링크가 죽은 것은 모델 탓이 아니다 — 나중에 사진이 올라오면 다시 시도할 수 있게 구분한다.
  check('다운로드 실패는 재시도 가능으로 표시', r.retryable, true);
  r = await ocr.readOdometerKm('x.jpg', fakeReader({ odometerKm: 12345, confidence: 0.2 }));
  check('모델이 못 읽은 것은 재시도 대상이 아니다', !!r.retryable, false);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
