const amqp = require('amqplib');
const logger = require('../utils/logger');

let connection = null;
let channel = null;

const RABBITMQ_URL = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST}`;

const QUEUES = {
  NOTIFICATIONS: 'notifications',
  NOTIFICATIONS_DLQ: 'notifications.dlq',
};

async function connect() {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Setup queues
    await channel.assertQueue(QUEUES.NOTIFICATIONS, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'dlx',
        'x-dead-letter-routing-key': QUEUES.NOTIFICATIONS_DLQ,
        'x-message-ttl': 86400000, // 24 hours
        'x-max-priority': 10,
      },
    });

    await channel.assertQueue(QUEUES.NOTIFICATIONS_DLQ, {
      durable: true,
      arguments: {
        'x-message-ttl': 604800000, // 7 days
      },
    });

    logger.info('RabbitMQ connection established');

    connection.on('error', (err) => {
      logger.error('RabbitMQ connection error', err);
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
    });

    return { connection, channel };
  } catch (error) {
    logger.error('Failed to connect to RabbitMQ', error);
    throw error;
  }
}

async function getChannel() {
  if (!channel) {
    await connect();
  }
  return channel;
}

async function publishToQueue(queueName, message, options = {}) {
  try {
    const ch = await getChannel();
    const messageBuffer = Buffer.from(JSON.stringify(message));

    return ch.sendToQueue(queueName, messageBuffer, {
      persistent: true,
      priority: options.priority || 5,
      ...options,
    });
  } catch (error) {
    logger.error(`Failed to publish message to queue ${queueName}`, error);
    throw error;
  }
}

async function consumeFromQueue(queueName, callback, options = {}) {
  try {
    const ch = await getChannel();

    await ch.prefetch(options.prefetch || 10);

    return ch.consume(
      queueName,
      async (msg) => {
        if (msg !== null) {
          try {
            const content = JSON.parse(msg.content.toString());
            await callback(content, msg);
            ch.ack(msg);
          } catch (error) {
            logger.error('Error processing message', error);
            // Reject and requeue if retries available
            const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;
            if (retryCount < 3) {
              ch.nack(msg, false, true); // Requeue
            } else {
              ch.nack(msg, false, false); // Send to DLQ
            }
          }
        }
      },
      { noAck: false }
    );
  } catch (error) {
    logger.error(`Failed to consume from queue ${queueName}`, error);
    throw error;
  }
}

module.exports = {
  connect,
  getChannel,
  publishToQueue,
  consumeFromQueue,
  QUEUES,
};