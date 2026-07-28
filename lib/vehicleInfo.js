const PLATE_RE = /(\d{2,3}\s?[가-힣]\s?\d{4})/;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePlate(value) {
  return cleanText(value).replace(/\s+/g, '');
}

function sanitizeTypeCandidate(value) {
  return cleanText(value)
    .replace(/[()\[\]{}]/g, ' ')
    .replace(/[,:;/]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(차종|차량|차량번호)\s*/i, '')
    .trim();
}

function splitTypeAndPlate(rawType, rawNumber) {
  let vehicleType = sanitizeTypeCandidate(rawType);
  let vehicleNumber = cleanText(rawNumber);

  function absorbPlateFrom(fieldValue) {
    const text = cleanText(fieldValue);
    if (!text) return null;
    const match = text.match(PLATE_RE);
    if (!match) return null;
    return {
      plate: normalizePlate(match[1]),
      typeHint: sanitizeTypeCandidate(text.replace(match[1], ' ')),
    };
  }

  const fromNumber = absorbPlateFrom(vehicleNumber);
  if (fromNumber) {
    vehicleNumber = fromNumber.plate;
    if (!vehicleType && fromNumber.typeHint) vehicleType = fromNumber.typeHint;
  }

  const fromType = absorbPlateFrom(vehicleType);
  if (fromType) {
    if (!vehicleNumber) vehicleNumber = fromType.plate;
    vehicleType = fromType.typeHint || vehicleType;
  }

  return {
    vehicleType: vehicleType || null,
    vehicleNumber: vehicleNumber || null,
  };
}

module.exports = {
  PLATE_RE,
  splitTypeAndPlate,
};
