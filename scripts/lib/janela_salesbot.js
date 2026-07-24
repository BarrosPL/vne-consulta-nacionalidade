export function isSalesbotBusinessHours(date = new Date()) {
  const day = date.getDay();
  const hour = date.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

export function nextSalesbotBusinessTime(date = new Date()) {
  const next = new Date(date);
  next.setMilliseconds(0);
  next.setSeconds(0);
  const day = next.getDay();
  const hour = next.getHours();
  if (day >= 1 && day <= 5 && hour < 9) {
    next.setHours(9, 0, 0, 0);
    return next;
  }
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}
