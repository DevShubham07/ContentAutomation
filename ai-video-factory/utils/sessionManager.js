import fs from "fs-extra";
import path from "node:path";

const PROFILES_PATH = path.resolve(process.cwd(), "profiles.json");

/**
 * Ensures the profiles data file exists.
 */
async function ensureProfilesFile() {
  if (!(await fs.pathExists(PROFILES_PATH))) {
    await fs.writeJson(PROFILES_PATH, { profiles: {} }, { spaces: 2 });
  }
}

/**
 * Reads the raw profiles data.
 */
async function readProfiles() {
  await ensureProfilesFile();
  try {
    return await fs.readJson(PROFILES_PATH);
  } catch {
    return { profiles: {} };
  }
}

/**
 * Writes the raw profiles data.
 */
async function writeProfiles(data) {
  await fs.writeJson(PROFILES_PATH, data, { spaces: 2 });
}

/**
 * Helper to get the current YYYY-MM string.
 */
function getCurrentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Checks a specific service quota on a profile. If it was exhausted
 * in a previous month, it resets the exhaustion state.
 */
function checkAndResetQuota(profileData, serviceName) {
  const currentMonth = getCurrentMonthStr();
  const service = profileData[serviceName] || {};
  
  if (service.exhaustedMonth && service.exhaustedMonth !== currentMonth) {
    // It's a new month! Reset the quota logic.
    service.exhaustedMonth = null;
    profileData[serviceName] = service;
    return true; // Indicate that a reset occurred
  }
  return false;
}

/**
 * Registers a new profile.
 * 
 * @param {string} profileName - the unique name for this profile (e.g. "account1")
 */
export async function registerProfile(profileName) {
  const data = await readProfiles();
  if (!data.profiles[profileName]) {
    data.profiles[profileName] = {
      createdAt: new Date().toISOString(),
      googleFlow: { exhaustedMonth: null },
      elevenLabs: { exhaustedMonth: null }
    };
    await writeProfiles(data);
  }
}

/**
 * Gets an available profile that has not exhausted the specified service for the current month.
 * If no specific service is given, just returns the first available or default profile.
 * 
 * @param {string} requiredService - "googleFlow" or "elevenLabs"
 * @returns {string|null} - The name of the profile, or null if all are exhausted.
 */
export async function getAvailableProfile(requiredService) {
  const data = await readProfiles();
  let updated = false;

  const currentMonth = getCurrentMonthStr();

  // Reset quotas if moving to a new month
  for (const [name, profile] of Object.entries(data.profiles)) {
    if (requiredService) {
      updated = checkAndResetQuota(profile, requiredService) || updated;
    } else {
      updated = checkAndResetQuota(profile, "googleFlow") || updated;
      updated = checkAndResetQuota(profile, "elevenLabs") || updated;
    }
  }

  if (updated) {
    await writeProfiles(data);
  }

  // Find a valid profile
  for (const [name, profile] of Object.entries(data.profiles)) {
    if (!requiredService) return name; // No specific service requested

    const serviceData = profile[requiredService] || {};
    if (serviceData.exhaustedMonth !== currentMonth) {
      return name;
    }
  }

  return null; // All registered profiles are exhausted for this service
}

/**
 * Marks a profile as exhausted for a specific service for the current month.
 * 
 * @param {string} profileName - the profile that ran out of credits
 * @param {string} serviceName - "googleFlow" or "elevenLabs"
 */
export async function markProfileExhausted(profileName, serviceName) {
  if (!profileName || !serviceName) return;

  const data = await readProfiles();
  if (!data.profiles[profileName]) return;

  if (!data.profiles[profileName][serviceName]) {
    data.profiles[profileName][serviceName] = {};
  }
  
  data.profiles[profileName][serviceName].exhaustedMonth = getCurrentMonthStr();
  await writeProfiles(data);
}
