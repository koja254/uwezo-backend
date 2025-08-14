import fetch from 'node-fetch';

async function testFormSubmission(formName, formData, endpoint) {
  console.log(`Testing ${formName} form on ${endpoint}...`);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        'form-name': formName,
        ...formData
      }),
    });

    const responseText = await response.text();
    if (response.ok) {
      console.log(`${formName} submission successful:`, responseText);
    } else {
      console.error(`${formName} submission failed: ${response.status} ${responseText}`);
    }
  } catch (error) {
    console.error(`${formName} submission error:`, error);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const testForms = async (endpoint = 'http://localhost:3000/webhook') => {
  console.log(`Running tests against ${endpoint}`);
  await testFormSubmission('newsletter', {
    email: 'test1@example.com',
    firstName: 'John',
    lastName: 'Doe',
    interests: ['programs']
  }, endpoint);
  await delay(1000);

  await testFormSubmission('volunteer', {
    name: 'John Doe',
    email: 'test2@example.com',
    phone: '1234567890',
    skills: 'Programming',
    experience: '3 years coding',
    motivation: 'To help youth learn tech'
  }, endpoint);
  await delay(1000);

  await testFormSubmission('get-involved', {
    name: 'Jane Doe',
    email: 'test3@example.com',
    phone: '0987654321',
    interest: 'Volunteer',
    experience: 'Teaching experience',
    message: 'Excited to contribute!'
  }, endpoint);
  await delay(1000);

  await testFormSubmission('partnership', {
    organizationName: 'Test Org',
    contactName: 'Jane Smith',
    email: 'test4@example.com',
    phone: '1122334455',
    partnershipType: 'NGO',
    description: 'Collaborate on STEM education',
    resources: 'Funding and mentors'
  }, endpoint);
};

(async () => {
  // Test local endpoint
  await testForms('http://localhost:3000/webhook');
  // Test Render endpoint
  await testForms('https://uwezo-backend.onrender.com/webhook');
})();