import fs from "fs-extra";
import path from "node:path";
import { getAvailableProfile, markProfileExhausted, registerProfile } from "./utils/sessionManager.js";

async function runTests() {
  const profilesPath = path.resolve(process.cwd(), "profiles.json");
  console.log("--- Removing existing profiles.json ---");
  await fs.remove(profilesPath).catch(() => {});

  console.log("\n--- Registering Profiles ---");
  await registerProfile("acc1");
  await registerProfile("acc2");
  
  let p = await getAvailableProfile("googleFlow");
  console.log("Initial available for googleFlow:", p); // expects acc1
  
  console.log("\n--- Marking acc1 as exhausted ---");
  await markProfileExhausted("acc1", "googleFlow");

  p = await getAvailableProfile("googleFlow");
  console.log("After exhaustion, available for googleFlow:", p); // expects acc2

  console.log("\n--- Marking acc2 as exhausted ---");
  await markProfileExhausted("acc2", "googleFlow");

  p = await getAvailableProfile("googleFlow");
  console.log("After both exhausted, available for googleFlow:", p); // expects null

  console.log("\n--- Simulating a Past Month for acc1 ---");
  const data = await fs.readJson(profilesPath);
  data.profiles["acc1"]["googleFlow"].exhaustedMonth = "2020-01";
  await fs.writeJson(profilesPath, data, { spaces: 2 });

  p = await getAvailableProfile("googleFlow");
  console.log("After simulating a new month, available for googleFlow:", p); // expects acc1
  
  const updatedData = await fs.readJson(profilesPath);
  console.log("Is exhaustedMonth null?", updatedData.profiles["acc1"]["googleFlow"].exhaustedMonth === null);

  console.log("\n--- Testing login.js CLI ---");
  // We won't test login interactively but the profiles.json is generated.
}

runTests().catch(console.error);
