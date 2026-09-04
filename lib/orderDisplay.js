// 오더 목록 화면에 쓰는 표시용 문자열. EJS와 Next 표가 같은 값을 보여주도록 서버에서 한 번
// 만들어 내려보낸다 — 화면마다 각자 가공하면 같은 오더가 화면에 따라 다르게 보인다.

// 담당자 칸에 쓸 이름.
//
// users.name에 회사명이 붙어 있는 경우가 있다("서울모터스 채정식"). 목록에서 요청 법인은
// 이미 따로 있고 고객 화면에서는 모든 줄이 같은 법인이라, 이름마다 회사명이 반복되면
// 정작 사람 이름이 뒤로 밀려 한눈에 안 들어온다. 그 오더의 요청 법인 이름이 앞에 붙어
// 있을 때만 떼어낸다.
//
// **일치할 때만 뗀다.** 공백으로 잘라 앞 토큰을 버리는 식으로 만들면 "김 하늘"처럼 이름에
// 공백이 있는 사람이 "하늘"이 된다. 회사명과 정확히 겹치는 접두어만 도려내면 그런 일이 없다.
function creatorLabel(row) {
  const raw = String((row && row.created_by_name) || '').trim();
  const group = String((row && row.group_name) || '').trim();
  let name = raw;
  if (group && name.length > group.length && name.startsWith(group)) {
    // 회사명 **바로 뒤에 구분자가 올 때만** 뗀다. 구분자를 요구하지 않으면 법인명이
    // "서울모터스"이고 사용자 이름이 "서울모터스강남 이철수"인 경우에 "강남 이철수"로
    // 잘려서, 다른 회사 이름이 조용히 뭉개진다.
    const tail = name.slice(group.length);
    const rest = /^[\s·\-_/|()[\]]/.test(tail)
      ? tail.replace(/^[\s·\-_/|()[\]]+/, '').trim()
      : '';
    if (rest) name = rest;
  }
  // 이름이 아예 없는 계정이 있다 — 카카오로만 소통하는 고객은 아이디만 자동 생성된다
  // (routes/users.js ensureUniqueLoginId). 그때 빈칸이면 누구인지 알 수 없어 아이디를 쓴다.
  return name || String((row && row.created_by_login) || '').trim() || '-';
}

module.exports = { creatorLabel };
