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
const API_KEY = process.env.API_KEY;
const WALLET_INDEX = parseInt(process.env.WALLET_INDEX || "0", 10);

const PROJECT_NAME = "Cyber Ape Frens";
const LIST_TIMEOUT = 86400; //24h（OpenSea 当前重复上架显示限制） //#48h-> sec（OpenSea 48h 内重复上架不显示，必须等 48h 才能重挂）

Logger.info("==========================KEYS===============================");
// 安全：助记词/API key 打码显示，避免暴露（GitHub Actions 日志公开）
const mask = (s, keep = 6) => s ? s.slice(0, keep) + "..." + s.slice(-4) : "(未设置)";
Logger.warn(`WALLET_INDEX = ${WALLET_INDEX}`);
Logger.warn(`NODE_API_KEY = ${mask(INFURA_KEY, 8)}`);
Logger.warn(`NFT_CONTRACT_ADDRESS = ${NFT_CONTRACT_ADDRESS}`);
Logger.warn(`OWNER_ADDRESS = ${OWNER_ADDRESS}`);
Logger.warn(`NETWORK = ${NETWORK}`);
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
const listTime = 1440; //m -> 24h 挂单有效期（与循环周期同步）（与循环周期一致，无缝衔接）
// 动态间隔：保证一轮恰好 48h，避免 48h 内重复上架（重复挂单不显示）
const CYCLE_SECONDS = 86400; // 24h
let intervalTime = 10000; // 初始默认 10s，每轮开始按 token 数重算
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

// v11 SDK: 用 ethers v6 + 助记词按 WALLET_INDEX 派生钱包
const provider = new ethers.JsonRpcProvider("https://mainnet.infura.io/v3/" + INFURA_KEY);
const hd = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${WALLET_INDEX}`);
const wallet = new ethers.Wallet(hd.privateKey, provider);

Logger.info(`Wallet address = ${wallet.address}`);
if (wallet.address.toLowerCase() !== OWNER_ADDRESS.toLowerCase()) {
    Logger.warn(`⚠️  WALLET 地址(${wallet.address}) 与 OWNER_ADDRESS(${OWNER_ADDRESS}) 不一致，将使用 wallet 地址签名`);
}

const openseaSDK = new OpenSeaSDK(wallet, {
    chain: Chain.Mainnet,
    apiKey: API_KEY
}, Logger.opensea);

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
    // 每轮开始重算：interval = 48h / 当前 token 数（保证一轮 48h，首单到期正好重挂）
    const n = tokens.length > 0 ? tokens.length : 10000;
    intervalTime = Math.max(Math.floor((CYCLE_SECONDS * 1000) / n), 4000); // 最低 4s（15000 token 也能 24h 一轮）
    Logger.info(`🔁 新一轮开始: token数=${n}, 间隔=${(intervalTime/1000).toFixed(1)}s, 一轮时长=${(CYCLE_SECONDS/3600).toFixed(0)}h`);
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
        const listing = await openseaSDK.createListing({
            asset: {
                tokenId: tokenId,
                tokenAddress: NFT_CONTRACT_ADDRESS
            },
            amount: price,
            expirationTime: expirationTime,
            accountAddress: OWNER_ADDRESS,
            listingTime: listingTime,
        });

        Logger.success(`Successfully created a listing! tokenId: ${tokenId}, price: ${price} ETH, cost sec = ${(Date.now() / 1000 - current_time).toFixed(2)}, current_index: ${current_index}`);

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
        // 已卖出/无效资产类错误 → 剔除该 token，继续下一个
        if (/404|not found|does not exist|doesn'?t exist|no asset|invalid asset|not indexed|NOT_FOUND|asset.*not/i.test(errMsg)) {
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
