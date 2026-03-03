import { load } from "cheerio";

/**
 * Minimal cookie jar for Cloudflare Workers.
 * Stores "name=value" pairs from Set-Cookie and sends them on subsequent requests.
 */
class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> value
  }

  absorbSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return;

    // In Workers, headers.getSetCookie() exists. If not, we fall back to parsing a combined header.
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

    for (const sc of arr) {
      if (!sc) continue;
      const firstPart = sc.split(";")[0];
      const eq = firstPart.indexOf("=");
      if (eq === -1) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  headerValue() {
    if (this.cookies.size === 0) return "";
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

function text(el) {
  return (el?.text?.() ?? "").replace(/\s+/g, " ").trim();
}

// --- Section parsers ---
// NOTE: They now accept TWO params: ($section, $) so they can wrap nodes with $(node)

function getTechDataDict($section, $) {
  const result = {};
  const $table = $section.find("table").first();
  $table.find("tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if ($tds.length === 0) return;
    const name = text($tds.eq(0)).replace(/:/g, "").trim();
    let value = "";
    if ($tds.length > 1) value = text($tds.eq(1));
    result[name] = value;
  });
  return result;
}

function getBrakeDataDict($section, $) {
  const result = {};
  const $table = $section.find("table").first();

  const headers = [];
  $table.find("th").each((_, th) => headers.push(text($(th))));

  const $rows = $table.find("tr").slice(1); // skip header row
  let idx = 0;

  $rows.each((_, tr) => {
    const $cells = $(tr).find("td");
    if ($cells.length !== headers.length) return;

    const rowData = {};
    for (let i = 0; i < headers.length; i++) {
      rowData[headers[i]] = text($cells.eq(i));
    }
    result[String(idx)] = rowData;
    idx += 1;
  });

  return result;
}

function getCrashData($section, $) {
  const data = {};
  $section.find("table.table-list#refer-table").each((_, tbl) => {
    const $tbl = $(tbl);
    const category = text($tbl.find("b").first());
    const info = text($tbl.find("tr").eq(1).find("td").first());
    if (category) data[category] = info;
  });
  return data;
}

function getMilageData($section, $) {
  const data = {};
  const $tables = $section.find("table");
  const $second = $tables.eq(1);

  let idx = 0;
  $second.find("tr").slice(1).each((_, tr) => {
    const $cells = $(tr).find("td");
    if ($cells.length < 3) return;

    const date = text($cells.eq(0));
    const odometer = text($cells.eq(1));
    const mileage = text($cells.eq(2));
    data[idx] = { Datums: date, Odometrs: odometer, Nobraukums: mileage };
    idx += 1;
  });

  return data;
}

function getTaxDataDict($section, $) {
  const data = {};
  const $table = $section.find("table.table-list#refer-table").first();

  let idx = 0;
  $table.find("tr").each((_, tr) => {
    const $row = $(tr);
    const $variable = $row.find("td.variable").first();
    const $value = $row.find("td.value").first();

    if ($variable.length && $value.length) {
      const variable = text($variable);
      const value = text($value).replace(/-/g, "").trim();
      data[idx] = { Tips: value, Maksa: variable };
      idx += 1;
    }
  });

  return data;
}

function getInspectionData($section, $) {
  const result = {};
  const $table = $section.find("table").first();

  const headers = [];
  $table.find("th").each((_, th) => headers.push(text($(th))));

  let idx = 0;
  $table.find("tr").slice(1).each((_, tr) => {
    const $cells = $(tr).find("td");
    if ($cells.length !== headers.length) return;

    const rowData = {};
    for (let i = 0; i < headers.length; i++) {
      rowData[headers[i]] = text($cells.eq(i));
    }
    result[String(idx)] = rowData;
    idx += 1;
  });

  return result;
}

function getPrevInspectionData($section, $) {
  const result = { Apraksts: {}, Detalizētais_vērtējums: {} };

  const $tables = $section.find("table");
  const $first = $tables.eq(0);
  const $second = $tables.eq(1);

  $first.find("tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if ($tds.length < 2) return;
    const name = text($tds.eq(0)).replace(/:/g, "").trim();
    const value = text($tds.eq(1));
    result.Apraksts[name] = value;
  });

  const headers = [];
  $second.find("th").each((_, th) => headers.push(text($(th))));

  let idx = 0;
  $second.find("tr").each((_, tr) => {
    const $cells = $(tr).find("td");
    if ($cells.length !== headers.length) return;

    const rowData = {};
    for (let i = 0; i < headers.length; i++) {
      rowData[headers[i]] = text($cells.eq(i));
    }
    result.Detalizētais_vērtējums[String(idx)] = rowData;
    idx += 1;
  });

  return result;
}

// --- Database functions ---

async function saveSearchToDatabase(plateText, data, env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') {
    console.error('Database not available');
    return { success: false, error: 'Database not available' };
  }

  // helper: find a value from an object by checking for substring matches (case‑insensitive)
  function findValue(obj, keywords) {
    for (const key of Object.keys(obj)) {
      for (const kw of keywords) {
        if (key.toLowerCase().includes(kw.toLowerCase())) {
          return obj[key];
        }
      }
    }
    return null;
  }

  try {
    // log raw scraped data for debugging
    console.log('saveSearchToDatabase - incoming data for', plateText, JSON.stringify(data));

    // Extract relevant fields from scraped data.  We try a couple of common key names
    const techData = data.Tehniskie_dati || {};
    let make = techData['Marka'] || techData['Zīmols'] || null;
    let model = techData['Modelis'] || null;
    let power = techData['Jauda'] || techData['Cilindru tilpums'] || null;

    // If any of the above ended up null, search generically
    if (!make) make = findValue(techData, ['marka', 'zīmol']);
    if (!model) model = findValue(techData, ['model']);
    if (!power) power = findValue(techData, ['jauda', 'power', 'kw']);

    // log extraction results and keys
    console.log('techData keys', Object.keys(techData));
    console.log('extracted make/model/power', { make, model, power });

    // Extract year from year data if available; primary value or first-registration date
    let year = null;
    if (techData['Izlaiduma gads']) {
      year = techData['Izlaiduma gads'];
    } else if (techData['Pirmās reģistrācijas datums']) {
      // often a full date string; just take the year portion
      const dt = techData['Pirmās reģistrācijas datums'];
      const match = dt.match(/(\d{4})/);
      if (match) year = match[1];
      else year = dt;
    }

    // Extract mileage: first try odometer reading in techData, otherwise fall back to history
    let mileage = null;
    if (techData['Odometra rādījums']) {
      mileage = techData['Odometra rādījums'];
    }
    if (!mileage) {
      const mileageData = data.Nobraukuma_vēsture_LV || {};
      console.log('mileageData keys', Object.keys(mileageData));
      const mileageKeys = Object.keys(mileageData).filter(k => k !== '_debug');
      if (mileageKeys.length > 0) {
        // Get the last entry (highest index)
        const lastKey = mileageKeys.reduce((max, key) => {
          const num = parseInt(key);
          return isNaN(num) ? max : Math.max(max, num);
        }, -1);
        if (lastKey >= 0) {
          const lastEntry = mileageData[lastKey];
          if (lastEntry && lastEntry.Nobraukums) {
            mileage = lastEntry.Nobraukums;
          } else {
            // fallback: look for any value containing "nobrauk"
            mileage = findValue(lastEntry || {}, ['nobrauk']);
          }
        }
      }
    }

    console.log('extracted year/mileage', { year, mileage });

    // Insert into database
    const stmt = env.DB.prepare(
      'INSERT INTO searches (number_plate, make, model, power, mileage, year) VALUES (?, ?, ?, ?, ?, ?)'
    );
    
    // execute the statement and wait for the promise to resolve
    const executionResult = await stmt
      .bind(plateText.trim(), make, model, power, mileage, year)
      .run();

    // .run() returns an object with `meta` when successful
    // store the id for debugging or return value
    const lastId = executionResult?.meta?.last_row_id ?? null;
    return { success: true, id: lastId };
  } catch (error) {
    console.error('Database save error:', error);
    return { success: false, error: error.message };
  }
}

// --- Main logic ---

async function getCarData(plateText, env) {
  if (!plateText || !plateText.trim()) {
    return { error: "empty_input" };
  }

  const loginUrl = "https://e.csdd.lv/login/?action=doLogin";
  const searchUrl = "https://e.csdd.lv/tadati/";

  const email = env.CSDD_EMAIL;
  const pwd = env.CSDD_PWD;

  if (!email || !pwd) {
    return { error: "missing_credentials" };
  }

  const jar = new CookieJar();

  async function doFetch(url, init = {}) {
    const headers = new Headers(init.headers || {});
    const cookieHeader = jar.headerValue();
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    headers.set("User-Agent", "cf-worker");

    const res = await fetch(url, { ...init, headers, redirect: "manual" });

    // Capture cookies
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : null;
    if (setCookies && setCookies.length) {
      jar.absorbSetCookie(setCookies);
    } else {
      const sc = res.headers.get("set-cookie");
      if (sc) jar.absorbSetCookie(sc);
    }

    return res;
  }

  // Login
  const loginBody = new URLSearchParams({ email, psw: pwd });
  const loginRes = await doFetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: loginBody.toString(),
  });

  if (![200, 302, 303].includes(loginRes.status)) {
    return { error: "login_failed", status: loginRes.status };
  }

  // Search by plate
  const searchBody = new URLSearchParams({ rn: plateText.trim() });
  const searchRes = await doFetch(searchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: searchBody.toString(),
  });

  const html = await searchRes.text();
  const $ = load(html);

  const $accordion = $(".accordion").first();
  if (!$accordion || $accordion.length === 0) {
    return { error: "car_not_found", debug: "No accordion found" };
  }

  const sections = $accordion.find("section");
  if (sections.length === 0) {
    return { error: "no_sections", debug: "Accordion found but has no sections", html_sample: html.substring(0, 500) };
  }

  const endDict = {};
  const foundLabels = [];
  $accordion.find("section").each((_, sec) => {
    const $sec = $(sec);
    let label = text($sec.find("label").first());
    // Extract just the label text before any CSS styling
    label = label.split(" .svg-accordion-arrow")[0].trim();
    foundLabels.push(label);
    const key = label.replace(/\s+/g, "_");

    if (label === "Tehniskie dati") endDict[key] = getTechDataDict($sec, $);
    else if (label === "Bremžu vērtējums") endDict[key] = getBrakeDataDict($sec, $);
    else if (label === "Būtiski bojājumi CSNg") endDict[key] = getCrashData($sec, $);
    else if (label === "Nobraukuma vēsture LV") endDict[key] = getMilageData($sec, $);
    else if (label === "Transportlīdzekļa ekspluatācijas nodoklis") endDict[key] = getTaxDataDict($sec, $);
    else if (label === "Detalizētais vērtējums") endDict[key] = getInspectionData($sec, $);
    else if (label === "Iepriekšējās apskates dati") endDict[key] = getPrevInspectionData($sec, $);
  });

  endDict._debug = { foundLabels, totalSections: sections.length };
  return endDict;
}

// --- Worker entrypoint ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Example: GET /car?rn=AB1234
    if (url.pathname === "/car") {
      const rn = url.searchParams.get("rn") || "";
      const data = await getCarData(rn, env);
      
      // Save to database if successful
      if (!data.error && rn && rn.trim()) {
        await saveSearchToDatabase(rn, data, env);
      }
      
      return Response.json(data, {
        status: data.error ? 400 : 200,
        headers: corsHeaders,
      });
    }

    return new Response("OK. Use /car?rn=PLATE", {
      status: 200,
      headers: corsHeaders,
    });
  },
};