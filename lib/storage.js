// 기사 사진 업로드를 위한 Supabase Storage 헬퍼 (공개 버킷, 서비스 롤 키로 서버에서만 접근)
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'order-photos';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
    }
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return client;
}

async function ensureBucket() {
  const supabase = getClient();
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets || !buckets.find((b) => b.name === BUCKET)) {
    await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: '10MB' });
  }
}

async function uploadPhoto(orderId, filename, buffer, contentType) {
  const supabase = getClient();
  const path = `${orderId}/${Date.now()}_${filename}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { ensureBucket, uploadPhoto };
