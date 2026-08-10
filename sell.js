const { OpenSeaSDK, Chain } = require("@opensea/sdk");
const { ethers } = require("ethers");
const fs = require("fs");
const random = require("random");
const Logger = require("./Logger");

require("dotenv").config();

const MNEMONIC = process.env.MNEMONIC;
const INFURA_KEY = process.env.INFURA_KEY;
const OWNER_ADDRESS = process.env.OWNER_ADDRESS;
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS;
const NETWORK = process.env.NETWORK;
// base64 解码 key 列表（防止 gh 设置 secrets 时逗号截断——用 base64 传输，解码回逗号分隔）
function parseKeyList(str) {
    if (!str) return "";
    try {
        const decoded = Buffer.from(str.trim(), 'base64').toString();
        const keys = decoded.split(',').map(k => k.trim()).filter(k => /^[a-f0-9]{32}$/i.test(k));
        if (keys.length >= 1) return decoded;
    } catch (e) {}
    return str;
}
// 收集多个 env 的 key（支持 API_KEY_1/2/3... 或逗号分隔/base64）
function collectKeys(prefix, fallback) {
    const arr = [];
    for (let i = 1; i <= 12; i++) {
        const v = process.env[prefix + i];
        if (v && v.trim().length > 10) arr.push(v.trim());
    }
    if (arr.length === 0 && fallback) {
        arr.push(...parseKeyList(fallback).split(',').map(k => k.trim()).filter(k => k.length > 10));
    }
    return arr;
}
const API_KEYS = collectKeys('API_A_', process.env.API_KEYS || process.env.API_KEY || "");
const API_KEY = API_KEYS[0] || "";
const WALLET_INDEX = parseInt(process.env.WALLET_INDEX || "0", 10);

const PROJECT_NAME = "Cyber Ape Frens";
const LIST_TIMEOUT = 86400; //24h（已取消保护，check_list_time 直接通过）

Logger.info("==========================KEYS===============================");
// 安全：助记词/API key 打码显示，避免暴露（GitHub Actions 日志公开）
const mask = (s, keep = 6) => s ? s.slice(0, keep) + "..." + s.slice(-4) : "(未设置)";
Logger.warn(`WALLET_INDEX = ${WALLET_INDEX}`);
Logger.warn(`INFURA_KEY(旧,仅日志) = ${mask(INFURA_KEY, 8)}`);
Logger.warn(`NFT_CONTRACT_ADDRESS = ${NFT_CONTRACT_ADDRESS}`);
Logger.warn(`OWNER_ADDRESS = ${OWNER_ADDRESS}`);
Logger.warn(`NETWORK = ${NETWORK}`);
Logger.warn(`API_KEY 数量 = ${API_KEYS.length}（轮动模式）`);
Logger.warn(`API_KEY = ${mask(API_KEY, 8)}`);
Logger.warn(`MNEMONIC = ${mask(MNEMONIC, 4)}`);
Logger.info("=============================================================");

// setting
var current_index = 0;
var err_retrycount = 0;
var tokens = [];
var cyclelist = true;

const RETRY_COUNT = 2;
const listforever = false;
const listTime = 720; //m -> 12h 挂单有效期
// 动态间隔：保证一轮恰好 48h，避免 48h 内重复上架（重复挂单不显示）
const CYCLE_SECONDS = 86400; // 24h
let intervalTime = 1000; // 3s（Infura 限流止血：46 repo 同时 1s 超 6 key 额度）
const listing_time = 0;

let max_price = process.env.MAX_PRICE || 0.1;
let min_price = process.env.MIN_PRICE || 0.012;

max_price = parseFloat(max_price);
min_price = parseFloat(min_price);

if (isNaN(max_price) || isNaN(min_price)) return Logger.err("max price or min price is not a number");

Logger.info("===========================SETTINGS==========================");
Logger.warn(`LIST FOREVER = ${listforever}`);
Logger.warn(`LIST TIME = ${listTime}`);
Logger.warn(`INTERVAL TIME = ${intervalTime}`);
Logger.warn(`MIN PRICE = ${min_price}`);
Logger.warn(`MAX PRICE = ${max_price}`);
Logger.info("=============================================================");

function wait(ms) {
    return new Promise(resolve => setTimeout(() => resolve(), ms));
}

// 超时包裹：防止网络挂起导致卡死（createListing 无响应时 60s 后抛错）
async function withTimeout(promise, ms, msg) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg || "Timeout")), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

// 看门狗：8 分钟无任何挂单进展 → 强制退出（防止隐藏卡点导致永远 in_progress）
let lastActivity = Date.now();
setInterval(() => {
    if (Date.now() - lastActivity > 8 * 60 * 1000) {
        console.error("⏰ 看门狗：8 分钟无进展，强制退出");
        process.exit(1);
    }
}, 60 * 1000);

// v11 SDK: 用 ethers v6 + 助记词按 WALLET_INDEX 派生钱包
// Infura 轮动：多 key 组合（API key × Infura key），挂单轮换
const INFURA_KEYS = collectKeys('INFURA_A_', process.env.INFURA_KEYS || INFURA_KEY || "");
const hd = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${WALLET_INDEX}`);

Logger.info(`Wallet address = ${hd.address}`);
if (hd.address.toLowerCase() !== OWNER_ADDRESS.toLowerCase()) {
    Logger.warn(`⚠️  WALLET 地址(${hd.address}) 与 OWNER_ADDRESS(${OWNER_ADDRESS}) 不一致，将使用 wallet 地址签名`);
}

// 多 RPC 节点轮动（每 repo 分配 2+ 节点 URL——轮换；1 个时固定）
const openseaSDKs = [];
for (const infuraKey of INFURA_KEYS) {
    const _rpcUrl = String(infuraKey).startsWith("http") ? infuraKey : "https://mainnet.infura.io/v3/" + infuraKey;
    const provider = new ethers.JsonRpcProvider(_rpcUrl);
    const w = new ethers.Wallet(hd.privateKey, provider);
    for (const apiKey of API_KEYS) {
        openseaSDKs.push({ sdk: new OpenSeaSDK(w, { chain: Chain.Mainnet, apiKey }, Logger.opensea), apiKey, infuraKey });
    }
}
let sdkIdx = 0;

function isFileExisted(filepath) {
    try {
        if (fs.existsSync(filepath)) {
            return true;
        }
        return false;
    } catch (e) {
        Logger.err(e);
        return false;
    }
}

function readLines(filepath) {
    var lines = [];
    var allFileContents = fs.readFileSync(filepath, "utf-8");
    allFileContents.split(/\r?\n/).forEach(line => {
        if (line == "") {
            return;
        }
        lines.push(line);
    });
    return lines;
}

//list index
function recordListIndex(list_index) {
    try {
        fs.writeFileSync(PROJECT_NAME + "_last_request.id", list_index.toString());
    } catch (e) {
        Logger.err(e);
    }
}

function loadListIndex() {
    if (isFileExisted(PROJECT_NAME + "_last_request.id")) {
        var cachedContext = fs.readFileSync(PROJECT_NAME + "_last_request.id", "utf-8");
        try {
            if (cachedContext != undefined)
                current_index = parseInt(cachedContext);
        }
        catch (e) {
            Logger.err(`existsSync ${e}`);
        }
    }
}

//time
function record_list_time(token) {
    if (token == "") return;

    let sec = Math.floor(Date.now() / 1000);
    let date = new Date(Date.now());
    let datestr = date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate() + " " + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds();
    let str = token + "#" + sec + "#" + datestr;

    let filepath = `${PROJECT_NAME}-record-list-token.json`;
    if (isFileExisted(filepath) == false) {
        fs.writeFileSync(filepath, "");
    }

    let lines = readLines(filepath);
    let ischange = false;
    for (let index = 0; index < lines.length; index++) {
        arr = lines[index].replace("\n", "").replace("\r", "").split("#");
        if (arr.length >= 1 && token == arr[0]) {
            lines[index] = str;
            ischange = true;
            break;
        }
    }

    if (!ischange) lines.push(str);

    fs.truncateSync(filepath, -1);
    lines.forEach(line => {
        fs.appendFileSync(filepath, line + "\n");
    });
}

function check_list_time(token) {
    // 已取消 24h 保护：任何 token 都允许立即重挂（用户配置：最大化上架）
    return true;
    if (token == "") return true;

    filepath = `${PROJECT_NAME}-record-list-token.json`;
    if (isFileExisted(filepath) == false) {
        fs.writeFileSync(filepath, "");
    }
    record_time = 0;
    lines = readLines(filepath);
    for (let index = 0; index < lines.length; index++) {
        arr = lines[index].replace("\n", "").replace("\r", "").split("#");
        if (arr.length >= 1 && token == arr[0]) {
            record_time = parseInt(arr[1]);
            break;
        }
    }

    sec = Math.floor(Date.now() / 1000);
    offset = sec - record_time;
    if (offset > LIST_TIMEOUT) return true;

    Logger.check(`check list time fail token: ${token}, left time: ${LIST_TIMEOUT - offset}`);
    return false;
}

function recalcInterval() {
    // 3s 间隔（Infura 限流止血）
    intervalTime = 1000;
    const n = tokens.length > 0 ? tokens.length : 10000;
    Logger.info(`🔁 固定间隔: token数=${n}, 间隔=3s`);
}

///start
async function main() {
    // 每轮（回到 index 0）重算间隔
    if (current_index === 0 && err_retrycount === 0) {
        recalcInterval();
    }
    // 批处理模式：时间到自动退出（GitHub Actions 需要保存状态）
    if (RUN_MINUTES > 0 && (Date.now() - BATCH_START) > RUN_MINUTES * 60000) {
        Logger.info(`⏰ 批处理时间到（${RUN_MINUTES}分钟），退出并保存状态`);
        process.exit(0);
    }

    const price = random.float((min_price), (max_price)).toFixed(3);

    const current_time = Date.now() / 1000;
    let expirationTime = Math.round(current_time + 60 * listTime);
    let listingTime = undefined;

    if (listing_time > 0) listingTime = Math.round(current_time + 60 * listing_time);
    if (current_index >= tokens.length) current_index = 0;

    try {
        const tokenId = tokens[current_index].toString();

        if (listforever) expirationTime = 0;
        if (!check_list_time(tokenId)) {
            await wait(60000);
            current_index += 0;
            main();
            return;
        }

        Logger.info(`Start list: expirationTime: ${expirationTime}, tokenId: ${tokenId}, current_time: ${current_time}, current_index: ${current_index}`);
        console.log(expirationTime);
        const _combo = openseaSDKs[sdkIdx % openseaSDKs.length];
        Logger.info(`INFURA实际=${_combo.infuraKey.slice(0,8)} API实际=${_combo.apiKey.slice(0,8)} idx=${sdkIdx % openseaSDKs.length}`);
        sdkIdx++;
        const listing = await withTimeout(_combo.sdk.createListing({
            asset: {
                tokenId: tokenId,
                tokenAddress: NFT_CONTRACT_ADDRESS
            },
            amount: price,
            expirationTime: expirationTime,
            accountAddress: OWNER_ADDRESS,
            listingTime: listingTime,
        }), 60000, "createListing 超时(60s)");

        Logger.success(`Successfully created a listing! tokenId: ${tokenId}, price: ${price} ETH, cost sec = ${(Date.now() / 1000 - current_time).toFixed(2)}, current_index: ${current_index}`);
        lastActivity = Date.now();

        if (current_index >= tokens.length) {
            current_index = 0;
        } else {
            current_index += 1;
        }

        recordListIndex(current_index);
        record_list_time(tokenId);
        err_retrycount = 0;
        if (intervalTime > 0) {
            await wait(intervalTime);
        }

    } catch (e) {
        const errMsg = (e && e.message) ? e.message : String(e);
        // enforcement 提示：OpenSea 版税强制校验提示，但订单实际已创建（网页显示+可购买）→ 当作成功
        if (/enforcement/i.test(errMsg)) {
            Logger.warn(`⚠️ enforcement 提示（订单已创建）: ${tokens[current_index]}  | ${errMsg.slice(0, 60)}`);
            record_list_time(tokens[current_index]);
            err_retrycount = 0;
            lastActivity = Date.now();
            if (intervalTime > 0) {
                await wait(intervalTime);
            }
            // 不 return：让流程继续（下方推进 index + main() 递归）
        } else if (/404|not found|does not exist|doesn'?t exist|no asset|invalid asset|not indexed|NOT_FOUND|asset.*not/i.test(errMsg)) {
            Logger.warn(`🚫 token 已卖出/无效，剔除: ${tokens[current_index]}  | ${errMsg.slice(0, 80)}`);
            try {
                // 从 tokens.json 移除该行
                const filepath = `${PROJECT_NAME}-tokens.json`;
                const lines = readLines(filepath).filter(t => t !== tokens[current_index]);
                fs.writeFileSync(filepath, lines.join('\n') + (lines.length ? '\n' : ''));
                // 记录剔除日志
                fs.appendFileSync(`${PROJECT_NAME}-removed-tokens.txt`, tokens[current_index] + "\n");
            } catch (removeErr) {
                Logger.err(`剔除失败: ${removeErr}`);
            }
            err_retrycount = 0;
        } else {
            Logger.err(`logerr: ${errMsg}, err_retrycount: ${err_retrycount}, current_index: ${current_index}`);
            err_retrycount += 1;
            if (err_retrycount > RETRY_COUNT) {
                await wait(15000);
            }
        }
        // 推进 index（失败也前进，不卡住）
        if (current_index >= tokens.length - 1) {
            current_index = 0;
        } else {
            current_index += 1;
        }
        recordListIndex(current_index);
    }

    if (!cyclelist && current_index == 0)
        process.exit();

    main();
}

// 批处理模式（GitHub Actions 用）：跑到指定分钟数后自动退出（供状态持久化）
const RUN_MINUTES = parseInt(process.env.RUN_MINUTES || "0", 10);
const BATCH_START = Date.now();

async function start() {
    loadListIndex();
    tokens = readLines(`${PROJECT_NAME}-tokens.json`);
    recalcInterval();
    await wait(2000); //5000 //msz
    main().catch(err => {
        Logger.err(`Main error: ${err}`);
    });
}

start();
