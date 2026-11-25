function formatDate(value) {
  if (!value) {
    return '-';
  }

  const raw = String(value).trim();

  const timestamp = Date.parse(raw);

  if (Number.isNaN(timestamp)) {
    return raw;
  }

  const BEIJING_OFFSET =
    8 * 60 * 60 * 1000;

  const beijingDate =
    new Date(
      timestamp + BEIJING_OFFSET,
    );

  const pad = (number) =>
    String(number).padStart(2, '0');

  const year =
    beijingDate.getUTCFullYear();

  const month =
    pad(
      beijingDate.getUTCMonth() + 1,
    );

  const day =
    pad(
      beijingDate.getUTCDate(),
    );

  const hour24 =
    beijingDate.getUTCHours();

  const minute =
    pad(
      beijingDate.getUTCMinutes(),
    );

  const period =
    hour24 >= 12
      ? 'PM'
      : 'AM';

  const hour12 =
    hour24 % 12 || 12;

  return (
    `${year}/${month}/${day} ` +
    `${hour12}:${minute} ${period}`
  );
}

module.exports = { formatDate };
