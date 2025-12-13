function success(data, statusCode = 200, meta = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify({
      success: true,
      data,
      meta: {
        requestId: meta.requestId,
        timestamp: new Date().toISOString(),
        ...meta,
      },
    }),
  };
}

function error(errorCode, message, statusCode = 400, details = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify({
      success: false,
      error: {
        code: errorCode,
        message,
        details,
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    }),
  };
}

module.exports = {
  success,
  error,
};