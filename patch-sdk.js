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
