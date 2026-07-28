// Express 4는 async 핸들러에서 발생한 rejection을 자동으로 next(err)로 넘기지 않으므로 래핑한다.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
