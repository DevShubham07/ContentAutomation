import dotenv from "dotenv";
import { launchBrowser } from "./utils/browser.js";

dotenv.config();

async function check() {
  try {
    const { browser, context } = await launchBrowser();
    console.log("Main context cookies count:", (await context.cookies()).length);
    
    const secondaryContext = await browser.newContext();
    console.log("Secondary context cookies count:", (await secondaryContext.cookies()).length);
    
    await browser.close();
  } catch (err) {
    console.error("Error:", err.message);
  }
}

check();
