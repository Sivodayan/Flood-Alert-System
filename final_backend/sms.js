require('dotenv').config()

async function sendSMS(recipient, message) {
  try {
    const response = await fetch('https://app.text.lk/api/v3/sms/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SMS_key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        recipient: recipient,     
        sender_id: "TextLKDemo",
        type: "plain",
        message: message
      })
    });

    const data = await response.json();
    console.log(data);
    return data;

  } catch (error) {
    console.error('SMS send failed:', error);
    throw error;
  }
}


module.exports = {
 sendSMS
};














