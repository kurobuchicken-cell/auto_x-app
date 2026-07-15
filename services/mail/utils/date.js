'use strict';

function getJSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}

function getDateRange() {
  const jstNow = getJSTDate();
  const dayOfWeek = jstNow.getDay(); // 0=日, 1=月

  const endDate = new Date(jstNow);
  endDate.setHours(0, 0, 0, 0);

  const startDate = new Date(jstNow);
  if (dayOfWeek === 1) {
    startDate.setDate(jstNow.getDate() - 2); // 土曜
  } else {
    startDate.setDate(jstNow.getDate() - 1); // 前日
  }
  startDate.setHours(0, 0, 0, 0);

  return { startDate, endDate, isMonday: dayOfWeek === 1, jstNow };
}

function formatGmailDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

function formatShortDate(date) {
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const dayName = dayNames[date.getDay()];
  return `${month}/${day}(${dayName})`;
}

function formatDisplayDate(jstNow, isMonday, startDate, endDate) {
  const year = jstNow.getFullYear();
  const month = String(jstNow.getMonth() + 1).padStart(2, '0');
  const day = String(jstNow.getDate()).padStart(2, '0');
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dayName = dayNames[jstNow.getDay()];
  const today = `${year}/${month}/${day}(${dayName})`;

  if (isMonday) {
    const rangeEnd = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
    return `${today}　対象: ${formatShortDate(startDate)}〜${formatShortDate(rangeEnd)}`;
  }
  return `${today}　対象: ${formatShortDate(startDate)}`;
}

module.exports = { getJSTDate, getDateRange, formatGmailDate, formatDisplayDate, formatShortDate };
