const playwright = require("playwright");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function runScript() {
  const scriptCode = process.env.SCRIPT_CODE;
  const outputKey = process.env.OUTPUT_KEY;

  console.log("Starting script execution...");
  console.log("SCRIPT_CODE:", scriptCode);
  console.log("OUTPUT_KEY:", outputKey);

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  }); // Fix for blank screenshots in Docker
  const page = await browser.newPage();

  let data = {};
  let errorLog = "";

  try {
    console.log("Evaluating user script...");
    const func = new Function(`return ${scriptCode}`)();
    data = await func(page);
    console.log("Script executed successfully. Data:", data);
  } catch (error) {
    errorLog = error.toString();
    console.error("Script execution error:", errorLog);
  } finally {
    try {
      console.log("Taking screenshot...");
      await page.screenshot({ path: "/tmp/screenshot.png", fullPage: true });
      const screenshotSize = fs.statSync("/tmp/screenshot.png").size;
      console.log("Screenshot taken. File size:", screenshotSize, "bytes"); // Check if non-zero
    } catch (screenshotError) {
      errorLog += "\nScreenshot error: " + screenshotError.toString();
    }

    try {
      const dataBody = JSON.stringify(data);
      console.log("Uploading data.json with content:", dataBody); // Log before upload
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: `${outputKey}/data.json`,
          Body: dataBody,
        })
      );
      console.log("data.json uploaded successfully.");
    } catch (uploadError) {
      errorLog += "\nData upload error: " + uploadError.toString();
    }

    try {
      if (fs.existsSync("/tmp/screenshot.png")) {
        const screenshotBody = fs.readFileSync("/tmp/screenshot.png");
        console.log(
          "Uploading screenshot.png with size:",
          screenshotBody.length,
          "bytes"
        );
        await s3.send(
          new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: `${outputKey}/screenshot.png`,
            Body: screenshotBody,
          })
        );
        console.log("screenshot.png uploaded successfully.");
      } else {
        errorLog += "\nNo screenshot file found.";
      }
    } catch (uploadError) {
      errorLog += "\nScreenshot upload error: " + uploadError.toString();
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: `${outputKey}/logs.txt`,
        Body:
          errorLog ||
          "No errors, but check if data/screenshot are as expected.",
      })
    );

    await browser.close();
    process.exit(0);
  }
}

runScript();
