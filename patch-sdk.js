// patch-sdk.js - 容器内禁用 shared storefront -> adapter 重映射 + Infura 请求缓存优化
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();

// ========== 1. 禁用 shared storefront -> adapter 重映射 ==========
const p = path.join(cwd, 'node_modules', '@opensea', 'sdk', 'lib', 'utils', 'protocol.js');
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
    // PATCHED: 禁用 shared storefront -> adapter 重映射（订单签名用真实合约地址）
    return tokenAddress;
};`;
if (src.includes(old)) {
    src = src.replace(old, neu);
    fs.writeFileSync(p, src);
    console.log('✅ protocol.js patched (remap disabled)');
} else if (src.includes('PATCHED: 禁用 shared storefront')) {
    console.log('⏭️  protocol.js already patched');
} else {
    console.error('❌ protocol.js patch pattern not found');
    process.exit(1);
}

// ========== 2. seaport-js getCounter 缓存（counter 不变，避免每次挂单查 Infura）==========
const seaportPath = path.join(cwd, 'node_modules', '@opensea', 'seaport-js', 'lib', 'seaport.js');
if (fs.existsSync(seaportPath)) {
    let ss = fs.readFileSync(seaportPath, 'utf-8');
    let patched = false;
    // 兼容版本 A（1.x prototype 风格）
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
        console.log('✅ seaport.js counter cache patched (v1 prototype)');
    }
    // 兼容版本 B（4.x class 风格）
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
        console.log('✅ seaport.js counter cache patched (v4 class)');
    }
    if (patched) {
        fs.writeFileSync(seaportPath, ss);
    } else if (ss.includes('PATCH: counter 缓存')) {
        console.log('⏭️  counter cache already patched');
    } else {
        console.log('⚠️ counter patch pattern not found（可能版本不同）');
    }
} else {
    console.log('⚠️ seaport-js 不存在（跳过）');
}

console.log('✅ patch-sdk.js 完成');
