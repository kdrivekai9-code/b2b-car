import json, re, collections, datetime

recs = json.load(open('msgs.json', encoding='utf-8'))
byreq = collections.defaultdict(list)
for r in recs:
    if r['req']:
        byreq[r['req']].append(r)

AUTO = [
    (r'^\s*사진(\s*\d+\s*장)?\s*(메시지가 삭제되었습니다\.?)?\s*$', '사진'),
    (r'(출발\s*사진|도착\s*사진|출발전|도착후|계기판)', '사진캡션'),
    (r'(배정되었|배정\s*기사|기사명\s*[:：]|기사\s*01\d{8,9})', '배차통보'),
    (r'(미배정|배정\s*전입니다|배정되는대로)', '미배정안내'),
    (r'(접수하겠습니다|접수했습니다|접수완료|접수 하겠습니다)', '접수ack'),
    (r'^[\s]*(네+[~\s.!]*|넵+[~\s.!]*|감사합니다[\s.!~]*|알겠습니다[\s.!]*|확인(했|하겠)습니다[\s.!]*)+$', '단순응대'),
]

def is_auto(t):
    return any(re.search(p, t) for p, _ in AUTO)

full, partial, human = 0, 0, 0
for q, ms in byreq.items():
    agent = [m for m in ms if m['role'] == '상담원']
    if not agent:
        human += 1
        continue
    a = sum(1 for m in agent if is_auto(m['text']))
    if a == len(agent):
        full += 1
    elif a >= len(agent) * 0.5:
        partial += 1
    else:
        human += 1
n = len(byreq)
print('[요청 단위 자동화 가능성] 총 %d건' % n)
print('  상담원 발화가 100%% 정형 → 완전 자동 대상        %4d (%.1f%%)' % (full, 100 * full / n))
print('  절반 이상 정형 → 자동+상담원 보조                %4d (%.1f%%)' % (partial, 100 * partial / n))
print('  사람 판단 비중 큼                               %4d (%.1f%%)' % (human, 100 * human / n))

# 접수 폼이 있는 요청 중 상담원 응답이 ack 하나뿐인 비율
onlyack = 0
haveform = 0
for q, ms in byreq.items():
    if not any(m['role'] == '고객' and '[출발지]' in m['text'] for m in ms):
        continue
    haveform += 1
    agent = [m for m in ms if m['role'] == '상담원']
    if agent and all(re.search(r'(접수하겠습니다|접수했습니다|접수완료)', m['text']) or
                     re.search(r'^[\s]*(네+|넵+)[~\s.!]*$', m['text']) for m in agent):
        onlyack += 1
print('\n접수 폼이 포함된 요청 %d건 중, 상담원이 "접수하겠습니다"류로만 끝낸 건: %d (%.1f%%)'
      % (haveform, onlyack, 100 * onlyack / haveform))

# 주말 대화 여부
wd = collections.Counter()
for r in recs:
    if r['date']:
        d = datetime.date.fromisoformat(r['date'])
        wd['월화수목금토일'[d.weekday()]] += 1
print('\n[요일별 메시지]', dict(wd))
