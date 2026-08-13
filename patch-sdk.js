// patch-sdk.js - 禁用 shared storefront 重映射 + counter 缓存（减少 Infura 请求）
const fs = require('fs');
const path = require('path');

// ========== 1. 禁用 shared storefront -> adapter 重映射 ==========
const p = path.join(process.cwd(), 'node_modules', '@opensea', 'sdk', 'lib', 'utils', 'protocol.js');
if (!fs.existsSync(p)) {
    console.error('❌ 找不到 @opensea/sdk 的 protocol.js');
    process.exit(1);
}
let src = fs.readFileSync(p, 'utf-8');
const old = `const remapSharedStorefrontAddress = (tokenAddress) => {
    if (constants_2.SHARED_STOREFRONT_ADDRESSES.has(tokenAddress.toLowerCase())) {
        return (0, address_1.checksumAddress)(constants_2.SHARED_STOREFRONT_LAZY_MINT_ADAPTER_CROSS_CHAIN_ADDRESS);
    }
    return tokenAddress;
};`;
const neu = `const remapSharedStorefrontAddress = (tokenAddress) => {
    // PATCHED: 禁用 shared storefront -> adapter 重映射（订单必须用原始合约 0x495f 才能进订单簿）
    return tokenAddress;
};`;
if (src.includes(old)) {
    src = src.replace(old, neu);
    fs.writeFileSync(p, src);
    console.log('✅ SDK patched (remap 禁用)');
} else {
    if (src.includes('PATCHED')) { console.log('✅ SDK 已 patch 过'); }
    else { console.log('⚠️ 未找到原 remap 函数，检查 SDK 版本'); process.exit(1); }
}

// ========== 2. seaport-js getCounter 缓存（减少 Infura 请求）==========
const seaportPath = path.join(process.cwd(), 'node_modules', '@opensea', 'seaport-js', 'lib', 'seaport.js');
if (fs.existsSync(seaportPath)) {
    let ss = fs.readFileSync(seaportPath, 'utf-8');
    let patched = false;

    // v4.x class 格式
    const cOldB = `    getCounter(offerer) {
        return this.contract.getCounter(offerer);
    }`;
    const cNewB = `    getCounter(offerer) {
        // PATCH: counter 缓存（钱包 counter 不变，避免每次挂单查 Infura）
        if (this._counterCache && this._counterCache[offerer] !== undefined) {
            return Promise.resolve(this._counterCache[offerer]);
        }
        const _p = this.contract.getCounter(offerer);
        if (_p && typeof _p.then === 'function') {
            return _p.then((_c) => { if (!this._counterCache) { this._counterCache = {}; } this._counterCache[offerer] = _c; return _c; });
        }
        return _p;
    }`;
    if (ss.includes(cOldB) && !ss.includes('PATCH: counter 缓存')) {
        ss = ss.replace(cOldB, cNewB);
        patched = true;
    }

    // v1.x prototype 格式
    if (!patched) {
        const cOldA = `    Seaport.prototype.getCounter = function (offerer) {
        return this.contract
            .getCounter(offerer)
            .then(function (counter) { return counter.toNumber(); });
    };`;
        const cNewA = `    Seaport.prototype.getCounter = function (offerer) {
        // PATCH: counter 缓存（钱包 counter 不变，避免每次挂单查 Infura）
        if (this._counterCache && this._counterCache[offerer] !== undefined) {
            return Promise.resolve(this._counterCache[offerer]);
        }
        var _this = this;
        return this.contract
            .getCounter(offerer)
            .then(function (counter) { return counter.toNumber(); })
            .then(function (c) { if (!_this._counterCache) { _this._counterCache = {}; } _this._counterCache[offerer] = c; return c; });
    };`;
        if (ss.includes(cOldA) && !ss.includes('PATCH: counter 缓存')) {
            ss = ss.replace(cOldA, cNewA);
            patched = true;
        }
    }

    if (patched) {
        fs.writeFileSync(seaportPath, ss);
        console.log('✅ counter 缓存已启用');
    } else if (ss.includes('PATCH: counter 缓存')) {
        console.log('⏭️ counter 缓存已存在');
    } else {
        console.log('⚠️ counter patch 未匹配（seaport 版本未知）');
    }
} else {
    console.log('⚠️ seaport-js 未找到');
}

// ========== 3. 禁用余额/批准检查（跳过 multicall/supportsInterface——省 Infura 请求）==========
if (fs.existsSync(seaportPath)) {
    let ss2 = fs.readFileSync(seaportPath, 'utf-8');
    const oldCfg = 'balanceAndApprovalChecksOnOrderCreation = _e === void 0 ? true : _e';
    const newCfg = 'balanceAndApprovalChecksOnOrderCreation = _e === void 0 ? false : _e';
    if (ss2.includes(oldCfg) && !ss2.includes('PATCH: 禁用余额检查')) {
        ss2 = ss2.replace(oldCfg, newCfg);
        fs.writeFileSync(seaportPath, ss2);
        console.log('✅ 余额/批准检查已禁用（省 Infura 请求）');
    } else if (ss2.includes('PATCH: 禁用余额检查')) {
        console.log('⏭️ 余额检查已禁用');
    } else {
        console.log('⚠️ 配置 pattern 未匹配');
    }
}

// ========== 3. 禁用余额/批准检查（跳过 multicall/supportsInterface——省 Infura 请求）==========
if (fs.existsSync(seaportPath)) {
    let ss2 = fs.readFileSync(seaportPath, 'utf-8');
    const oldCfg = 'balanceAndApprovalChecksOnOrderCreation = _e === void 0 ? true : _e';
    const newCfg = 'balanceAndApprovalChecksOnOrderCreation = _e === void 0 ? false : _e';
    if (ss2.includes(oldCfg) && !ss2.includes('PATCH: 禁用余额检查')) {
        ss2 = ss2.replace(oldCfg, '// PATCH: 禁用余额检查（省 Infura） ' + newCfg);
        fs.writeFileSync(seaportPath, ss2);
        console.log('✅ 余额/批准检查已禁用（省 Infura 请求）');
    } else if (ss2.includes('PATCH: 禁用余额检查')) {
        console.log('⏭️ 余额检查已禁用');
    } else {
        console.log('⚠️ 配置 pattern 未匹配');
    }
}
// ========== 4. 缓存 getNFT/getCollection（挂单从每单 3 个 OpenSea 请求降到 1 个——限速 60/min/key）==========
const ordersPath = path.join(process.cwd(), 'node_modules', '@opensea', 'sdk', 'lib', 'sdk', 'orders.js');
if (fs.existsSync(ordersPath)) {
    let os = fs.readFileSync(ordersPath, 'utf-8');
    if (!os.includes('PATCH: NFT/collection 缓存')) {
        // 4a. 在类里插入两个缓存方法（插到 getNFTItems 前）
        const anchor = `    getNFTItems(nfts, quantities = []) {`;
        const methods = `    // PATCH: NFT/collection 缓存（同一合约的 tokenStandard/contract/collection 不变，只查一次）
    async _patchedGetNFT(tokenAddress, tokenId) {
        if (!this._nftInfoCache) { this._nftInfoCache = new Map(); }
        const key = String(tokenAddress).toLowerCase();
        if (this._nftInfoCache.has(key)) {
            const base = this._nftInfoCache.get(key);
            return { ...base, identifier: tokenId };
        }
        const { nft } = await this.context.api.getNFT(tokenAddress, tokenId);
        this._nftInfoCache.set(key, {
            tokenStandard: nft.tokenStandard,
            contract: nft.contract,
            collection: nft.collection,
        });
        return { ...this._nftInfoCache.get(key), identifier: tokenId };
    }
    async _patchedGetCollection(slug) {
        if (!this._collectionCache) { this._collectionCache = new Map(); }
        if (this._collectionCache.has(slug)) { return this._collectionCache.get(slug); }
        const c = await this.context.api.getCollection(slug);
        this._collectionCache.set(slug, c);
        return c;
    }
    getNFTItems(nfts, quantities = []) {`;
        if (os.includes(anchor)) { os = os.replace(anchor, methods); }
        else { console.log('⚠️ orders.js 锚点未找到'); process.exit(1); }

        // 4b. 替换 4 处 getNFT/getCollection 调用
        const oldA = `const { nft } = await this.context.api.getNFT(asset.tokenAddress, asset.tokenId);`;
        const newA = `const nft = await this._patchedGetNFT(asset.tokenAddress, asset.tokenId);`;
        const oldB = `const collection = await this.context.api.getCollection(nft.collection);`;
        const newB = `const collection = await this._patchedGetCollection(nft.collection);`;
        const na = os.split(oldA).length - 1;
        const nb = os.split(oldB).length - 1;
        if (na === 4 && nb === 4) {
            os = os.split(oldA).join(newA).split(oldB).join(newB);
            fs.writeFileSync(ordersPath, os);
            console.log(`✅ getNFT/getCollection 缓存已启用（替换 ${na} 处调用）`);
        } else {
            console.log(`⚠️ 调用次数异常: getNFT=${na}(期望4) getCollection=${nb}(期望4)`);
            process.exit(1);
        }
    } else {
        console.log('⏭️ NFT/collection 缓存已存在');
    }
} else {
    console.log('⚠️ orders.js 未找到');
}

// ========== 5. 禁用 SDK 内部 429 自动重试（3 次重试=4 请求打同一限速窗口，放大 429）==========
const rateLimitPath = path.join(process.cwd(), 'node_modules', '@opensea', 'sdk', 'lib', 'utils', 'rateLimit.js');
if (fs.existsSync(rateLimitPath)) {
    let rl = fs.readFileSync(rateLimitPath, 'utf-8');
    if (!rl.includes('PATCH: 禁用 SDK 重试')) {
        const oldMax = 'const DEFAULT_MAX_RETRIES = 3;';
        const newMax = 'const DEFAULT_MAX_RETRIES = 0; // PATCH: 禁用 SDK 重试（429 直接抛给 sell.js 处理，避免放大请求）';
        if (rl.includes(oldMax)) {
            rl = rl.replace(oldMax, newMax);
            fs.writeFileSync(rateLimitPath, rl);
            console.log('✅ SDK 429 自动重试已禁用（DEFAULT_MAX_RETRIES=0）');
        } else {
            console.log('⚠️ rateLimit.js 的 DEFAULT_MAX_RETRIES 未匹配');
        }
    } else {
        console.log('⏭️ SDK 重试已禁用过');
    }
} else {
    console.log('⚠️ rateLimit.js 未找到');
}
