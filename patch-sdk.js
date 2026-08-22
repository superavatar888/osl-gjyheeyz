// patch-sdk.js - 线上版 + enforcement 修复（zone/fee 兜底）
// 基于 dbab1 线上 patch-sdk.js（缓存 + 429 重试禁用）+ patch-sdk-enforcement.js 的 zone/fee 兜底
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

// ========== 2. seaport-js getCounter 缓存（减少 RPC 请求）==========
const seaportPath = path.join(process.cwd(), 'node_modules', '@opensea', 'seaport-js', 'lib', 'seaport.js');
if (fs.existsSync(seaportPath)) {
    let ss = fs.readFileSync(seaportPath, 'utf-8');
    let patched = false;

    const cOldB = `    getCounter(offerer) {
        return this.contract.getCounter(offerer);
    }`;
    const cNewB = `    getCounter(offerer) {
        // PATCH: counter 缓存（钱包 counter 不变，避免每次挂单查 RPC）
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

    if (!patched) {
        const cOldA = `    Seaport.prototype.getCounter = function (offerer) {
        return this.contract
            .getCounter(offerer)
            .then(function (counter) { return counter.toNumber(); });
    };`;
        const cNewA = `    Seaport.prototype.getCounter = function (offerer) {
        // PATCH: counter 缓存（钱包 counter 不变，避免每次挂单查 RPC）
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

// ========== 3. 禁用余额/批准检查 ==========
if (fs.existsSync(seaportPath)) {
    let ss2 = fs.readFileSync(seaportPath, 'utf-8');
    const oldCfg = 'balanceAndApprovalChecksOnOrderCreation = _e === void 0 ? true : _e';
    const newCfg = 'balanceAndApprovalChecksOnOrderCreation = _e === void 0 ? false : _e';
    if (ss2.includes(oldCfg) && !ss2.includes('PATCH: 禁用余额检查')) {
        ss2 = ss2.replace(oldCfg, newCfg);
        fs.writeFileSync(seaportPath, ss2);
        console.log('✅ 余额/批准检查已禁用');
    } else if (ss2.includes('PATCH: 禁用余额检查')) {
        console.log('⏭️ 余额检查已禁用');
    } else {
        console.log('⚠️ 配置 pattern 未匹配');
    }
}

// ========== 4. 缓存 getNFT/getCollection（省 OpenSea 请求）==========
const ordersPath = path.join(process.cwd(), 'node_modules', '@opensea', 'sdk', 'lib', 'sdk', 'orders.js');
if (fs.existsSync(ordersPath)) {
    let os = fs.readFileSync(ordersPath, 'utf-8');
    if (!os.includes('PATCH: NFT/collection 缓存')) {
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

        const oldA = `const { nft } = await this.context.api.getNFT(asset.tokenAddress, asset.tokenId);`;
        const newA = `const nft = await this._patchedGetNFT(asset.tokenAddress, asset.tokenId);`;
        const oldB = `const collection = await this.context.api.getCollection(nft.collection);`;
        const newB = `const collection = await this._patchedGetCollection(nft.collection);`;
        const na = os.split(oldA).length - 1;
        const nb = os.split(oldB).length - 1;
        if (na === 4 && nb === 4) {
            os = os.split(oldA).join(newA).split(oldB).join(newB);
            console.log(`✅ getNFT/getCollection 缓存已启用（替换 ${na} 处调用）`);
        } else {
            console.log(`⚠️ 调用次数异常: getNFT=${na}(期望4) getCollection=${nb}(期望4)`);
            process.exit(1);
        }
    } else {
        console.log('⏭️ NFT/collection 缓存已存在');
    }

    // ========== 4.5 enforcement 修复：强制 required_zone + required fee 兜底 ==========
    // 背景：dbab1/2 的 token 在 OpenSea 未正确索引 → SDK getNFT 返回 collection undefined
    // → getCollection(undefined) → fees/requiredZone 缺失 → 订单不满足 enforcement → 全被拒
    // 修复：zone 缺失时用 OpenSea Operator Filter 合约地址；fee 2 (0x02ed8db9, 200bp) 缺失时强制补上
    if (!os.includes('PATCH: enforcement 集合 zone 兜底')) {
        const zoneOld = `        if (collection.requiredZone) {
            zone = collection.requiredZone;
        }`;
        const zoneNew = `        if (collection.requiredZone) {
            zone = collection.requiredZone;
        }
        // PATCH: enforcement 集合 zone 兜底（SDK getNFT 拿不到 collection 时 requiredZone 缺失）
        if (!zone || zone === constants_1.ZERO_ADDRESS) {
            zone = "0x000056f7000000ece9003ca63978907a00ffd100";
        }`;
        if (os.includes(zoneOld)) {
            os = os.replace(zoneOld, zoneNew);
            console.log('✅ orders.js enforcement zone 兜底已启用');
        } else {
            console.log('⚠️ zone 兜底 pattern 未匹配');
        }

        const feeMarker = `            considerationFeeItems.push(...getPrivateListingConsiderations(offerAssetItems, buyerAddress));
        }`;
        const feeNew = `            considerationFeeItems.push(...getPrivateListingConsiderations(offerAssetItems, buyerAddress));
        }
        // PATCH: enforcement 集合 required fee 兜底（SDK 数据源缺失 fee 2）
        if (!considerationFeeItems.some(c => c.recipient && String(c.recipient).toLowerCase() === "0x02ed8db986f4c4ce3a73f0ede8e316c1bc90ad07")) {
            considerationFeeItems.push({
                token: paymentTokenAddress,
                amount: (0, utils_1.getAmountWithBasisPointsApplied)(basePrice, 200),
                recipient: "0x02ed8db986f4c4ce3a73f0ede8e316c1bc90ad07",
            });
        }`;
        if (os.includes(feeMarker)) {
            os = os.replace(feeMarker, feeNew);
            console.log('✅ orders.js enforcement fee2 兜底已启用');
        } else {
            console.log('⚠️ fee2 兜底 pattern 未匹配');
        }
        fs.writeFileSync(ordersPath, os);
    } else {
        console.log('⏭️ enforcement 兜底已存在');
    }
} else {
    console.log('⚠️ orders.js 未找到');
}

// ========== 5. 禁用 SDK 内部 429 自动重试 ==========
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




// ===== PATCH: chainId 硬编码(2026-08-22)——每单省 1 次 eth_chainId RPC =====
// seaport-js 签名时 _getDomainData 调 provider.getNetwork() 发 eth_chainId(Ankr 200 credits/次)
// 46 repo 满速挂单每月 ~9000 万次,占 92 key × 200M 额度 ~98%
// 硬编码主网 chainId=1:每单 RPC 归零(签名域与真实值一致,订单有效性不变)
// 注意:仅适用于以太坊主网;若换链(BSC/Arbitrum 等)需改 chainId 值
// v2:兼容 4.1.6 class 格式与 4.1.7+ prototype 编译格式,并打印 seaport-js 版本
const _pj = require('path').join(process.cwd(), 'node_modules', '@opensea', 'seaport-js', 'package.json');
try {
  console.log('[chainId-patch] seaport-js 版本:', require(_pj).version);
  const _fs = require('fs');
  const _sp = require('path').join(process.cwd(), 'node_modules', '@opensea', 'seaport-js', 'lib', 'seaport.js');
  if (_fs.existsSync(_sp)) {
    let _s = _fs.readFileSync(_sp, 'utf-8');
    if (!_s.includes('PATCH: chainId 硬编码')) {
      let _patched = false;
      // 格式1: 4.1.6 class 未编译
      const _old1 = 'const { chainId } = await this.provider.getNetwork();';
      if (_s.includes(_old1)) {
        _s = _s.replace(_old1, '// PATCH: chainId 硬编码主网(1)\n        const chainId = 1n;');
        _patched = true;
      }
      // 格式2: 4.1.7+ prototype 编译后(yield getNetwork → yield 常量对象)
      if (!_patched && _s.includes('case 0: return [4 /*yield*/, this.provider.getNetwork()];')) {
        _s = _s.replace('case 0: return [4 /*yield*/, this.provider.getNetwork()];', 'case 0: return [4 /*yield*/, Promise.resolve({ chainId: 1n })];');
        _patched = true;
      }
      if (_patched) {
        _fs.writeFileSync(_sp, _s);
        console.log('✅ chainId 已硬编码(每单省 1 次 eth_chainId)');
      } else {
        console.log('⚠️ chainId patch:未匹配 seaport 版本格式,请人工检查');
      }
    } else {
      console.log('⏭️ chainId 已硬编码(patch 已存在)');
    }
  } else {
    console.log('⚠️ seaport-js lib/seaport.js 未找到');
  }
} catch (e) { console.error('chainId patch 失败:', e.message); }
