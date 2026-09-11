// 요금 문의를 inquiries에 남긴다.
//
// 왜 모듈로 빼나: 지금까지 이 삽입은 `POST /inquiries` 라우트 안에만 있었고, EJS 챗봇이
// 그 라우트를 불러 기록을 만들었다. Next 챗봇은 그 호출이 없어서, 화면을 Next로 켜는 순간
// **요금 문의 기록이 통째로 끊긴다** — 문의 관리 화면이 비고 통계도 멈춘다.
//
// 클라이언트가 한 번 더 호출하게 만들지 않고 서버가 남긴다. 요금을 계산한 자리(요금 문의
// 엔드포인트)에는 이미 금액·거리·도선 여부가 다 있어서, 화면이 그것을 되돌려 보내는 왕복이
// 통째로 불필요하다. 화면이 달라져도 기록이 같은 모양으로 남는다는 점이 더 중요하다.
const db = require('../db');

// 한 건 넣고 id를 돌려준다. 실패는 던지지 않는다 — 기록은 곁가지이고, 고객에게 나갈 요금
// 안내가 그것 때문에 막히면 안 된다.
async function recordInquiry({
  user, branchId, groupId, chatSessionId,
  category, inquiryText,
  originText, destinationText, vehicleType,
  resolvedOrigin, resolvedDestination,
  estimatedDistanceKm, estimatedFare, fareSource, estimatedFerryFare,
  hasFerryLeg, ferryLegsJson,
}) {
  const text = String(inquiryText || '').trim();
  if (!user || !text) return null;
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  try {
    const inserted = await db.run(
      `INSERT INTO inquiries (
        chat_session_id, user_id, branch_id, requester_group_id,
        category, status, inquiry_text,
        origin_text, destination_text, vehicle_type,
        resolved_origin, resolved_destination,
        estimated_distance_km, estimated_fare, fare_source,
        estimated_ferry_fare,
        has_ferry_leg, ferry_legs_json
      ) VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
      [
        chatSessionId || null,
        user.id,
        branchId || null,
        groupId || null,
        ['fare', 'general'].includes(category) ? category : 'general',
        text,
        originText || null,
        destinationText || null,
        vehicleType || null,
        resolvedOrigin || null,
        resolvedDestination || null,
        num(estimatedDistanceKm),
        num(estimatedFare),
        fareSource || null,
        num(estimatedFerryFare),
        !!hasFerryLeg,
        ferryLegsJson || null,
      ]
    );
    return Number(inserted.lastInsertRowid);
  } catch (e) {
    console.error('요금 문의 기록 실패(안내는 계속):', e.message);
    return null;
  }
}

module.exports = { recordInquiry };
