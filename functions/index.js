const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { GoogleGenAI, Type } = require("@google/genai");

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

// Initialize Gemini API
const genAI = new GoogleGenAI({});

// Firestore trigger for new donations (2nd gen)
exports.processDonation = onDocumentCreated(
  {
    document: "donations/{donationId}",
    region: "us-central1", // Specify your preferred region
    memory: "1GiB", // Allocate more memory for image processing
    timeoutSeconds: 540, // 9 minutes timeout
    maxInstances: 10, // Limit concurrent executions
  },
  async (event) => {
    const donationData = event.data?.data();
    const donationId = event.params.donationId;

    if (!donationData) {
      console.log("No donation data found");
      return;
    }

    // Only process if state is pending
    if (donationData.state !== "pending") {
      console.log("Donation is not pending, skipping processing");
      return;
    }

    try {
      console.log(`Processing donation: ${donationId}`);

      // Step 1: Extract payslip data using Gemini API
      const extractedData = await extractPayslipData(donationData.payslip);

      if (!extractedData) {
        await updateDonationStatus(
          donationId,
          "declined",
          "Failed to extract payslip data"
        );
        return;
      }

      console.log("Extracted payslip data:", extractedData);

      // Step 2: Get organization bank details
      const orgBankDetails = await getOrganizationBankDetails(
        donationData.organizationId
      );

      if (!orgBankDetails) {
        await updateDonationStatus(
          donationId,
          "declined",
          "Organization bank details not found"
        );
        return;
      }

      // Step 3: Get donation service details
      const donationService = await getDonationService(
        donationData.donationServiceId
      );

      if (!donationService) {
        await updateDonationStatus(
          donationId,
          "declined",
          "Donation service not found"
        );
        return;
      }

      // Step 4: Validate the donation
      const validationResult = validateDonation(
        extractedData,
        orgBankDetails,
        donationService,
        donationData.units
      );

      // Step 5: Update donation status based on validation
      if (validationResult.isValid) {
        await updateDonationStatus(donationId, "accepted");
        console.log(`Donation ${donationId} accepted`);
      } else {
        await updateDonationStatus(
          donationId,
          "declined",
          validationResult.reason
        );
        console.log(
          `Donation ${donationId} declined: ${validationResult.reason}`
        );
      }

      // Step 6: Save extracted data for future reference (optional)
      await saveExtractedData(donationId, extractedData);
    } catch (error) {
      console.error("Error processing donation:", error);
      await updateDonationStatus(
        donationId,
        "declined",
        "Processing error occurred"
      );
    }
  }
);

// Extract payslip data using Gemini API with structured output
async function extractPayslipData(imageUrl) {
  try {
    // Fetch image from URL
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const imageArrayBuffer = await response.arrayBuffer();
    const base64ImageData = Buffer.from(imageArrayBuffer).toString("base64");

    // Define the schema for structured output
    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        transactionId: {
          type: Type.STRING,
          description: "Transaction reference number or ID",
        },
        amount: {
          type: Type.NUMBER,
          description: "Transfer amount as a number",
        },
        currency: {
          type: Type.STRING,
          description: "Currency code (e.g., LKR, USD)",
        },
        senderName: {
          type: Type.STRING,
          description: "Sender's name",
        },
        senderAccount: {
          type: Type.STRING,
          description: "Sender's account number",
        },
        recipientName: {
          type: Type.STRING,
          description: "Recipient's name",
        },
        recipientAccount: {
          type: Type.STRING,
          description: "Recipient's account number",
        },
        bankName: {
          type: Type.STRING,
          description: "Bank name",
        },
        bankBranch: {
          type: Type.STRING,
          description: "Bank branch",
        },
        transactionDate: {
          type: Type.STRING,
          description: "Transaction date in YYYY-MM-DD format",
        },
        transactionTime: {
          type: Type.STRING,
          description: "Transaction time",
        },
        description: {
          type: Type.STRING,
          description: "Payment description or reference",
        },
        status: {
          type: Type.STRING,
          description: "Transaction status (completed, pending, etc.)",
        },
      },
      propertyOrdering: [
        "transactionId",
        "amount",
        "currency",
        "senderName",
        "senderAccount",
        "recipientName",
        "recipientAccount",
        "bankName",
        "bankBranch",
        "transactionDate",
        "transactionTime",
        "description",
        "status",
      ],
      required: ["amount", "recipientName", "recipientAccount", "bankName"],
    };

    const prompt = `
      Analyze this bank transfer payslip/receipt image and extract all visible information.
      Pay special attention to:
      - Transaction amount and currency
      - Recipient details (name and account number)
      - Bank information (name and branch)
      - Transaction date and reference
      - Any other relevant payment details
      
      If any information is not clearly visible, return null for that field.
      Make sure the amount is extracted as a number without any currency symbols.
    `;

    const result = await genAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64ImageData,
          },
        },
        { text: prompt },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });

    const extractedData = JSON.parse(result.text);
    return extractedData;
  } catch (error) {
    console.error("Error extracting payslip data:", error);
    return null;
  }
}

// Get organization bank details
async function getOrganizationBankDetails(organizationId) {
  try {
    const doc = await db
      .collection("org_bank_details")
      .doc(organizationId)
      .get();

    if (!doc.exists) {
      console.log("Organization bank details not found");
      return null;
    }

    return doc.data();
  } catch (error) {
    console.error("Error getting organization bank details:", error);
    return null;
  }
}

// Get donation service details
async function getDonationService(donationServiceId) {
  try {
    const doc = await db
      .collection("donation_services")
      .doc(donationServiceId)
      .get();

    if (!doc.exists) {
      console.log("Donation service not found");
      return null;
    }

    return doc.data();
  } catch (error) {
    console.error("Error getting donation service:", error);
    return null;
  }
}

// Validate donation against extracted data
function validateDonation(
  extractedData,
  orgBankDetails,
  donationService,
  units
) {
  const validationErrors = [];

  // Check if recipient name matches (case-insensitive, fuzzy matching)
  if (extractedData.recipientName) {
    const extractedName = extractedData.recipientName.toLowerCase().trim();
    const expectedName = orgBankDetails.accountName.toLowerCase().trim();

    if (!isNameMatch(extractedName, expectedName)) {
      validationErrors.push(
        "Recipient name does not match organization account name"
      );
    }
  } else {
    validationErrors.push("Recipient name not found in payslip");
  }

  // Check if account number matches
  if (extractedData.recipientAccount) {
    const extractedAccount = extractedData.recipientAccount.replace(/\s/g, "");
    const expectedAccount = orgBankDetails.accountNumber.replace(/\s/g, "");

    if (extractedAccount !== expectedAccount) {
      validationErrors.push("Account number does not match");
    }
  } else {
    validationErrors.push("Account number not found in payslip");
  }

  // Check if bank name matches (fuzzy matching)
  if (extractedData.bankName) {
    const extractedBank = extractedData.bankName.toLowerCase();
    const expectedBank = orgBankDetails.bankName.toLowerCase();

    if (!isBankNameMatch(extractedBank, expectedBank)) {
      validationErrors.push("Bank name does not match");
    }
  } else {
    validationErrors.push("Bank name not found in payslip");
  }

  // Check if amount matches expected donation amount
  if (extractedData.amount) {
    const expectedAmount = donationService.approximateUnitPrice * units;
    const tolerance = expectedAmount * 0.05; // 5% tolerance

    if (Math.abs(extractedData.amount - expectedAmount) > tolerance) {
      validationErrors.push(
        `Amount mismatch. Expected: ${expectedAmount}, Found: ${extractedData.amount}`
      );
    }
  } else {
    validationErrors.push("Transaction amount not found in payslip");
  }

  // Check transaction status
  if (
    extractedData.status &&
    extractedData.status.toLowerCase() !== "completed"
  ) {
    validationErrors.push("Transaction is not completed");
  }

  return {
    isValid: validationErrors.length === 0,
    reason: validationErrors.length > 0 ? validationErrors.join("; ") : null,
  };
}

// Fuzzy name matching helper
function isNameMatch(extracted, expected) {
  // Remove common suffixes and prefixes
  const cleanExtracted = extracted
    .replace(/(ltd|limited|pvt|foundation|charity|organization|org)/g, "")
    .trim();
  const cleanExpected = expected
    .replace(/(ltd|limited|pvt|foundation|charity|organization|org)/g, "")
    .trim();

  // Check if names contain each other or have high similarity
  return (
    cleanExtracted.includes(cleanExpected) ||
    cleanExpected.includes(cleanExtracted) ||
    calculateSimilarity(cleanExtracted, cleanExpected) > 0.8
  );
}

// Fuzzy bank name matching helper
function isBankNameMatch(extracted, expected) {
  // Common bank name variations
  const bankAliases = {
    sampath: ["sampath bank", "sampath bank plc"],
    commercial: ["commercial bank", "commercial bank of ceylon"],
    peoples: ["peoples bank", "people's bank"],
    hnb: ["hatton national bank", "hnb"],
    dfcc: ["dfcc bank", "dfcc"],
    seylan: ["seylan bank"],
    ndb: ["national development bank", "ndb bank"],
    nsb: ["national savings bank", "nsb"],
  };

  const extractedLower = extracted.toLowerCase();
  const expectedLower = expected.toLowerCase();

  // Direct match
  if (
    extractedLower.includes(expectedLower) ||
    expectedLower.includes(extractedLower)
  ) {
    return true;
  }

  // Check aliases
  for (const [key, aliases] of Object.entries(bankAliases)) {
    if (
      extractedLower.includes(key) &&
      aliases.some((alias) => expectedLower.includes(alias))
    ) {
      return true;
    }
    if (
      expectedLower.includes(key) &&
      aliases.some((alias) => extractedLower.includes(alias))
    ) {
      return true;
    }
  }

  return false;
}

// Calculate string similarity using Levenshtein distance
function calculateSimilarity(str1, str2) {
  const matrix = [];
  const len1 = str1.length;
  const len2 = str2.length;

  for (let i = 0; i <= len2; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len1; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len2; i++) {
    for (let j = 1; j <= len1; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  const maxLen = Math.max(len1, len2);
  return (maxLen - matrix[len2][len1]) / maxLen;
}

// Update donation status
async function updateDonationStatus(donationId, status, note = null) {
  try {
    const updateData = {
      state: status,
      updatedAt: Date.now(),
    };

    if (note) {
      updateData.note = note;
    }

    await db.collection("donations").doc(donationId).update(updateData);

    console.log(
      `Updated donation ${donationId} to ${status}${
        note ? ` with note: ${note}` : ""
      }`
    );
  } catch (error) {
    console.error("Error updating donation status:", error);
  }
}

// Save extracted data for future reference
async function saveExtractedData(donationId, extractedData) {
  try {
    await db.collection("donation_extractions").doc(donationId).set({
      donationId,
      extractedData,
      extractedAt: new Date(),
    });

    console.log(`Saved extracted data for donation ${donationId}`);
  } catch (error) {
    console.error("Error saving extracted data:", error);
  }
}

// Manual processing function (for testing or reprocessing) - 2nd gen
exports.manualProcessDonation = onCall(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 300,
    maxInstances: 5,
  },
  async (request) => {
    // Check authentication
    if (!request.auth) {
      throw new Error("User must be authenticated.");
    }

    const { donationId } = request.data;

    if (!donationId) {
      throw new Error("Missing required field: donationId");
    }

    try {
      const donationDoc = await db
        .collection("donations")
        .doc(donationId)
        .get();

      if (!donationDoc.exists) {
        throw new Error("Donation not found");
      }

      const donationData = donationDoc.data();

      // Manually trigger the processing logic
      console.log(`Manual processing for donation: ${donationId}`);

      // Extract payslip data
      const extractedData = await extractPayslipData(donationData.payslip);

      if (!extractedData) {
        await updateDonationStatus(
          donationId,
          "declined",
          "Failed to extract payslip data"
        );
        return { success: false, message: "Failed to extract payslip data" };
      }

      // Get organization bank details
      const orgBankDetails = await getOrganizationBankDetails(
        donationData.organizationId
      );

      if (!orgBankDetails) {
        await updateDonationStatus(
          donationId,
          "declined",
          "Organization bank details not found"
        );
        return {
          success: false,
          message: "Organization bank details not found",
        };
      }

      // Get donation service details
      const donationService = await getDonationService(
        donationData.donationServiceId
      );

      if (!donationService) {
        await updateDonationStatus(
          donationId,
          "declined",
          "Donation service not found"
        );
        return { success: false, message: "Donation service not found" };
      }

      // Validate the donation
      const validationResult = validateDonation(
        extractedData,
        orgBankDetails,
        donationService,
        donationData.units
      );

      // Update donation status based on validation
      if (validationResult.isValid) {
        await updateDonationStatus(donationId, "accepted");
        await saveExtractedData(donationId, extractedData);
        return { success: true, message: "Donation accepted" };
      } else {
        await updateDonationStatus(
          donationId,
          "declined",
          validationResult.reason
        );
        return { success: false, message: validationResult.reason };
      }
    } catch (error) {
      console.error("Error in manual processing:", error);
      throw new Error("Failed to process donation: " + error.message);
    }
  }
);

// Health check function for monitoring
exports.healthCheck = onCall(
  {
    region: "us-central1",
    memory: "128MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    try {
      // Test Gemini API connection
      const testResult = await genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ text: "Hello, respond with just 'OK'" }],
      });

      // Test Firestore connection
      await db.collection("health_check").doc("test").set({
        timestamp: new Date(),
        status: "ok",
      });

      return {
        status: "healthy",
        timestamp: new Date().toISOString(),
        geminiApi: "connected",
        firestore: "connected",
        testResponse: testResult.text,
      };
    } catch (error) {
      console.error("Health check failed:", error);
      return {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error.message,
      };
    }
  }
);
