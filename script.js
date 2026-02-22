pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

// Initialize Cashfree SDK once at the top level
const cashfree = Cashfree({ mode: 'production' });

const fileInput = document.getElementById('documents');
const fileList = document.getElementById('file-list');
const customPagesInput = document.getElementById('custom-pages');
const pageSelectionRadios = document.querySelectorAll('input[name="pageSelection"]');
const calculateBtn = document.getElementById('calculate');
const payNowBtn = document.getElementById('pay-now');
const payLaterBtn = document.getElementById('pay-later');
const cancelBtn = document.getElementById('cancel');
const otpSection = document.getElementById('otp-section');
const otpValue = document.getElementById('otp-value');
const previewDiv = document.getElementById('preview');

let filesData = {}; // {filename: {file, numPages}}

fileInput.addEventListener('change', handleFiles);
pageSelectionRadios.forEach(radio => radio.addEventListener('change', toggleCustomInput));
calculateBtn.addEventListener('click', calculatePreview);
payNowBtn.addEventListener('click', () => processPayment('payNow'));
payLaterBtn.addEventListener('click', () => processPayment('payLater'));
cancelBtn.addEventListener('click', () => location.reload());

function toggleCustomInput() {
  customPagesInput.disabled = document.querySelector('input[name="pageSelection"]:checked').value !== 'custom';
}

async function handleFiles() {
  fileList.innerHTML = '';
  filesData = {};
  for (let file of fileInput.files) {
    if (file.type === 'application/pdf') {
      const numPages = await getPdfPages(file);
      filesData[file.name] = { file, numPages };
    } else {
      filesData[file.name] = { file, numPages: 0 }; // Non-PDF, no pages
    }
    const li = document.createElement('li');
    li.innerHTML = `${file.name} <button onclick="previewFile('${file.name}')">Preview</button> <button onclick="deleteFile('${file.name}')">Delete</button>`;
    fileList.appendChild(li);
  }
}

async function getPdfPages(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  return pdf.numPages;
}

function previewFile(filename) {
  const url = URL.createObjectURL(filesData[filename].file);
  window.open(url);
}

function deleteFile(filename) {
  delete filesData[filename];
  handleFiles(); // Refresh list
}

function parseCustomPages(str, maxPages) {
  if (!str) return [];
  const pages = new Set();
  str.split(',').forEach(part => {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      pages.add(Number(part));
    }
  });
  return Array.from(pages).filter(p => p >= 1 && p <= maxPages);
}

function calculatePreview() {
  const copies = parseInt(document.getElementById('copies').value) || 1;
  const pageSelection = document.querySelector('input[name="pageSelection"]:checked').value;
  const customStr = customPagesInput.value;
  const colorMode = document.querySelector('input[name="colorMode"]:checked').value;
  const orientation = document.querySelector('input[name="orientation"]:checked').value;
  const pagesPerSheet = document.querySelector('input[name="pagesPerSheet"]:checked').value;

  let totalPages = 0;
  let selectedPagesDesc = pageSelection === 'all' ? 'All Pages' : `Custom: ${customStr}`;

  Object.values(filesData).forEach(({ numPages }) => {
    let selectedCount;
    if (pageSelection === 'all') {
      selectedCount = numPages;
    } else {
      const selected = parseCustomPages(customStr, numPages);
      if (selected.length === 0) alert(`Invalid custom pages for a file with ${numPages} pages`);
      selectedCount = selected.length;
    }
    totalPages += selectedCount;
  });

  totalPages *= copies;
  const pricePerPage = colorMode === 'bw' ? 1 : 3;
  const price = totalPages * pricePerPage;

  previewDiv.innerHTML = `
    Total Logical Pages: ${totalPages}<br>
    Selected Pages: ${selectedPagesDesc}<br>
    Copies: ${copies}<br>
    Color Mode: ${colorMode === 'bw' ? 'Black & White' : 'Color'}<br>
    Final Price: ₹${price}
  `;

  return { totalPages, selectedPagesDesc, copies, colorMode, price, orientation, pagesPerSheet };
}

async function processPayment(method) {
  const previewData = calculatePreview();
  if (!previewData || Object.keys(filesData).length === 0) return alert('Select files and calculate preview first');

  const formData = new FormData();
  Object.values(filesData).forEach(({ file }) => formData.append('documents', file));
  formData.append('payMethod', method);
  formData.append('options', JSON.stringify({
    copies: previewData.copies,
    pageSelection: previewData.selectedPagesDesc,
    colorMode: previewData.colorMode,
    orientation: previewData.orientation,
    pagesPerSheet: previewData.pagesPerSheet
  }));
  formData.append('price', previewData.price);

  try {
    payNowBtn.disabled = true;
    payLaterBtn.disabled = true;

    const res = await fetch('/process', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.error) {
      alert(data.error);
      payNowBtn.disabled = false;
      payLaterBtn.disabled = false;
      return;
    }

    if (method === 'payLater') {
      showOTP(data.otp);
    } else {
      // Pay Now: Initiate Cashfree
      if (!data.sessionId) {
        console.error('Server did not return sessionId:', data);
        alert('Payment Gateway Error: ' + (data.error || 'Could not initialize payment session.') + '\n\nPlease use the "Pay Later" button instead.');
        payNowBtn.disabled = false;
        payLaterBtn.disabled = false;
        return;
      }

      console.log('Initiating Cashfree Checkout. Session:', data.sessionId);

      try {
        const result = await cashfree.checkout({
          paymentSessionId: data.sessionId,
          returnUrl: `${window.location.origin}/verify.html?order_id=${data.orderId}`
        });

        if (result.error) {
          console.error('Cashfree SDK Error:', result.error);
          alert('Payment Failed: ' + result.error.message + '\n\nPlease use "Pay Later" instead.');
          payNowBtn.disabled = false;
          payLaterBtn.disabled = false;
        }
      } catch (e) {
        console.error('Fatal Checkout Error:', e);
        alert('Gateway Error. Please use "Pay Later" instead.');
        payNowBtn.disabled = false;
        payLaterBtn.disabled = false;
      }
    }
  } catch (err) {
    alert('Error processing');
    payNowBtn.disabled = false;
    payLaterBtn.disabled = false;
  }
}

function showOTP(otp) {
  otpSection.style.display = 'block';
  otpValue.textContent = otp;
  // Hide other sections if needed
}