// ==UserScript==
// @name         小红书内容采集助手
// @name:en     XiaoHongShu Content Collector
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  在当前已打开的笔记页面采集标题、正文和互动数据，结果保存在浏览器本地，支持复制与导出 CSV（仅采集页面可见内容，不绕过登录或反爬，不做批量抓取）
// @description:en     Collect title, body and interaction metrics of the note currently open; data stays local. Visible page content only.
// @author       橙七
// @match        *://*.xiaohongshu.com/*
// @match        *://xiaohongshu.com/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // ---------- 工具函数 ----------

    // 节流
    function throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // HTML 转义，防止标题/正文注入页面结构
    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 解析互动数字：支持逗号、“1.2万”/“1.2w” 单位
    function parseCount(text) {
        if (!text) return 0;
        const clean = String(text).trim().replace(/,/g, '');
        if (!clean) return 0;
        if (/万|w/i.test(clean)) {
            const num = parseFloat(clean.replace(/万|w/i, ''));
            return isNaN(num) ? 0 : Math.round(num * 10000);
        }
        const num = parseInt(clean, 10);
        return isNaN(num) ? 0 : num;
    }

    // 复制文本：优先油猴剪贴板，回退到原生剪贴板与 execCommand
    function copyText(text) {
        if (typeof GM_setClipboard === 'function') {
            GM_setClipboard(text);
            return true;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
            return true;
        }
        return fallbackCopy(text);
    }

    function fallbackCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) {
            console.error('复制失败:', e);
            return false;
        }
    }

    // ---------- 样式 ----------

    GM_addStyle(`
        .xhs-scraper-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            background: #fff;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            z-index: 99999;
            width: 300px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            color: #222;
        }
        .xhs-scraper-btn {
            background: #ff2442;
            color: #fff;
            border: none;
            padding: 8px 15px;
            border-radius: 4px;
            cursor: pointer;
            margin: 5px 0;
            width: 100%;
            transition: background 0.3s ease;
        }
        .xhs-scraper-btn:hover { background: #e61e3c; }
        .xhs-scraper-btn:disabled {
            background: #ccc !important;
            cursor: not-allowed;
            opacity: 0.5;
        }
        .xhs-scraper-btn.reset { background: #666; }
        .xhs-scraper-btn.reset:hover { background: #555; }
        .xhs-scraper-result {
            margin-top: 10px;
            padding: 10px;
            background: #f5f5f5;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            word-break: break-all;
            font-size: 13px;
            line-height: 1.6;
        }
        .xhs-scraper-radio-group {
            display: flex;
            gap: 15px;
            margin: 10px 0;
            font-size: 14px;
        }
        .xhs-scraper-radio-item {
            display: flex;
            align-items: center;
            cursor: pointer;
            padding: 8px 12px;
            border-radius: 4px;
            border: 2px solid #ddd;
            transition: all 0.3s ease;
        }
        .xhs-scraper-radio-item:has(input:checked) {
            background-color: #ff2442;
            color: #fff;
            border-color: #ff2442;
        }
        .xhs-scraper-radio-item:not(:has(input:checked)):hover {
            border-color: #ff2442;
            color: #ff2442;
        }
        .xhs-scraper-radio-item input { display: none; }
        .xhs-scraper-count {
            margin-top: 10px;
            font-size: 14px;
            color: #666;
            text-align: center;
        }
    `);

    // ---------- 本地存储 ----------

    const STORAGE_KEY = 'xhs_scraped_notes';
    let elementCache = null;
    let lastCheckTime = 0;
    const CHECK_INTERVAL = 500;

    function checkNoteElements() {
        const now = Date.now();
        if (now - lastCheckTime < CHECK_INTERVAL && elementCache !== null) {
            return elementCache;
        }
        const title = document.querySelector(
            '.note-detail .title, .note-content .title, #detail-title, .title, h1'
        );
        const content = document.querySelector(
            '#detail-desc .note-text, .note-content .content, .note-detail .content, .note-desc, .content'
        );
        elementCache = !!(title && content && title.textContent.trim());
        lastCheckTime = now;
        return elementCache;
    }

    function updateScrapeButton() {
        const scrapeBtn = document.getElementById('scrapeBtn');
        if (!scrapeBtn) return;
        const result = document.getElementById('result');
        const canScrape = checkNoteElements();
        if (scrapeBtn.getAttribute('data-state') === String(canScrape)) return;
        scrapeBtn.setAttribute('data-state', String(canScrape));
        if (canScrape) {
            scrapeBtn.removeAttribute('disabled');
            scrapeBtn.style.background = '#ff2442';
            if (result) result.textContent = '可以开始采集内容';
        } else {
            scrapeBtn.setAttribute('disabled', 'true');
            scrapeBtn.style.background = '#ccc';
            if (result) result.textContent = '请进入笔记详情页使用采集功能';
        }
    }

    function getSavedNotes() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    function saveNote(note) {
        try {
            const notes = getSavedNotes();
            const currentUrl = window.location.href;
            const existingIndex = notes.findIndex(n => n.url === currentUrl);
            if (existingIndex !== -1) {
                notes[existingIndex] = Object.assign({}, note, { url: currentUrl });
            } else {
                notes.push(Object.assign({}, note, { url: currentUrl }));
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
            updateNoteCount();
        } catch (e) {
            console.error('保存笔记失败:', e);
        }
    }

    // ---------- 互动数据 ----------

    function extractMetrics() {
        const metrics = { likes: 0, favorites: 0, comments: 0 };
        try {
            const interactionContainers = document.querySelectorAll('.interactions');
            const bottomInteractions = Array.from(interactionContainers).pop();

            if (bottomInteractions) {
                const likesElem = bottomInteractions.querySelector('.like-wrapper .count');
                const collectElem = bottomInteractions.querySelector('.collect-wrapper .count, span[class^="collect"] .count');
                const commentElem = bottomInteractions.querySelector('.chat-wrapper .count, span[class^="chat"] .count');
                if (likesElem) metrics.likes = parseCount(likesElem.textContent);
                if (collectElem) metrics.favorites = parseCount(collectElem.textContent);
                if (commentElem) metrics.comments = parseCount(commentElem.textContent);
            }

            // 兜底：底部操作条上的计数
            if (!metrics.likes && !metrics.favorites && !metrics.comments) {
                const bottomBar = document.querySelector('.note-bottom-bar, .note-footer');
                if (bottomBar) {
                    const counts = Array.from(bottomBar.querySelectorAll('.count'))
                        .map(el => parseCount(el.textContent))
                        .filter(val => val > 0);
                    if (counts.length >= 3) {
                        metrics.likes = counts[0];
                        metrics.favorites = counts[1];
                        metrics.comments = counts[2];
                    }
                }
            }
            console.log('提取到的互动数据:', metrics);
        } catch (error) {
            console.error('提取互动数据失败:', error);
        }
        return metrics;
    }

    // ---------- 面板 ----------

    function createPanel() {
        if (document.querySelector('.xhs-scraper-panel')) return;

        const panel = document.createElement('div');
        panel.className = 'xhs-scraper-panel';
        panel.innerHTML = `
            <h3 style="margin: 0 0 10px 0; font-size: 15px;">小红书内容采集</h3>
            <div class="xhs-scraper-radio-group">
                <div class="xhs-scraper-radio-item">
                    <input type="radio" id="keepTopics" name="topicsOption" value="keep">
                    <label for="keepTopics">保留话题标签</label>
                </div>
                <div class="xhs-scraper-radio-item">
                    <input type="radio" id="removeTopics" name="topicsOption" value="remove" checked>
                    <label for="removeTopics">移除话题标签</label>
                </div>
            </div>
            <button class="xhs-scraper-btn" id="scrapeBtn" disabled>采集内容</button>
            <button class="xhs-scraper-btn" id="copyBtn">复制到剪贴板</button>
            <button class="xhs-scraper-btn" id="exportExcelBtn">导出 CSV</button>
            <button class="xhs-scraper-btn reset" id="resetBtn">重置数据</button>
            <div class="xhs-scraper-count" id="noteCount">已采集 0 篇笔记</div>
            <div class="xhs-scraper-result" id="result">请进入笔记详情页使用采集功能</div>
        `;

        document.body.appendChild(panel);
        bindEvents();
        updateNoteCount();
        updateScrapeButton();
    }

    const ensurePanelExists = throttle(() => {
        if (!document.querySelector('.xhs-scraper-panel')) createPanel();
    }, 1000);

    function extractTopicTags(element) {
        const topicTags = [];
        element.querySelectorAll('a').forEach(el => {
            if (el.classList.contains('topic') ||
                el.classList.contains('tag-item') ||
                el.id === 'hash-tag' ||
                el.href.includes('/tag/') ||
                el.textContent.startsWith('#')) {
                let tag = el.textContent.trim().replace(/#/g, '');
                if (tag) {
                    tag = '#' + tag;
                    if (!topicTags.includes(tag)) topicTags.push(tag);
                }
            }
        });
        return topicTags;
    }

    function bindEvents() {
        const radioButtons = document.querySelectorAll('input[name="topicsOption"]');
        radioButtons.forEach(radio => {
            radio.addEventListener('change', () => {
                if (window._lastScrapedContent) scrapeContent();
            });
        });
        document.getElementById('scrapeBtn').addEventListener('click', scrapeContent);
        document.getElementById('copyBtn').addEventListener('click', copyToClipboard);
        document.getElementById('exportExcelBtn').addEventListener('click', exportToCsv);
        document.getElementById('resetBtn').addEventListener('click', resetAllData);
    }

    function resetAllData() {
        if (confirm('确定要清空所有已采集的笔记吗？')) {
            localStorage.removeItem(STORAGE_KEY);
            window._lastScrapedContent = null;
            const result = document.getElementById('result');
            if (result) result.innerHTML = '';
            updateNoteCount();
        }
    }

    function updateNoteCount() {
        const count = getSavedNotes().length;
        const countDiv = document.getElementById('noteCount');
        if (countDiv) countDiv.textContent = `已采集 ${count} 篇笔记`;
    }

    // ---------- 采集 ----------

    function scrapeContent() {
        const resultDiv = document.getElementById('result');
        const radio = document.querySelector('input[name="topicsOption"]:checked');
        if (!radio) return;
        const includeTopics = radio.value === 'keep';

        try {
            const title = document.querySelector('.note-detail .title') ||
                document.querySelector('.note-content .title') ||
                document.querySelector('#detail-title') ||
                document.querySelector('.title') ||
                document.querySelector('h1');

            const contentElement = document.querySelector('#detail-desc .note-text') ||
                document.querySelector('.note-content .content') ||
                document.querySelector('.note-detail .content') ||
                document.querySelector('.note-desc') ||
                document.querySelector('.content');

            if (!title || !contentElement) {
                if (resultDiv) resultDiv.textContent = '未找到内容，请确保在笔记详情页使用';
                return;
            }

            const cleanContent = contentElement.cloneNode(true);
            const topicTags = extractTopicTags(cleanContent);
            cleanContent.querySelectorAll('a, button, .interact-item, .location-info, .ip-location').forEach(el => el.remove());

            let contentText = cleanContent.textContent
                .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
                .replace(/([。！？，、；：])+/g, '$1')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n\s*\n\s*\n+/g, '\n\n')
                .trim();

            if (includeTopics && topicTags.length > 0) {
                contentText += '\n\n' + topicTags.join(' ');
            }

            const metrics = extractMetrics();
            const result = {
                url: window.location.href,
                title: title.textContent.trim(),
                content: contentText,
                timestamp: new Date().toISOString(),
                likes: metrics.likes,
                favorites: metrics.favorites,
                comments: metrics.comments
            };

            saveNote(result);

            if (resultDiv) {
                resultDiv.innerHTML =
                    '<strong>标题：</strong><br>' + escapeHtml(result.title) + '<br><br>' +
                    '<strong>正文：</strong><br>' + escapeHtml(result.content).replace(/\n/g, '<br>') + '<br><br>' +
                    '<strong>互动数据：</strong><br>' +
                    `点赞：${result.likes} | 收藏：${result.favorites} | 评论：${result.comments}`;
            }

            window._lastScrapedContent = result;
        } catch (error) {
            if (resultDiv) resultDiv.textContent = '采集失败：' + error.message;
        }
    }

    // ---------- 复制 / 导出 ----------

    function copyToClipboard() {
        const notes = getSavedNotes();
        if (notes.length === 0) {
            alert('还没有采集任何笔记！');
            return;
        }
        const textToCopy = notes.map(note =>
            `标题：${note.title}\n\n正文：${note.content}\n\n互动数据：点赞 ${note.likes} | 收藏 ${note.favorites} | 评论 ${note.comments}`
        ).join('\n\n-------------------\n\n');

        const ok = copyText(textToCopy);
        alert(ok ? '所有笔记内容已复制到剪贴板！' : '复制失败，请检查浏览器剪贴板权限');
    }

    function csvEscape(value) {
        return String(value == null ? '' : value).replace(/"/g, '""');
    }

    function exportToCsv() {
        const notes = getSavedNotes();
        if (notes.length === 0) {
            alert('还没有采集任何笔记！');
            return;
        }

        const csvHeader = '链接,标题,正文,点赞数,收藏数,评论数,采集时间\n';
        const csvRows = notes.map(note => {
            const values = [
                note.url,
                note.title,
                note.content,
                note.likes || 0,
                note.favorites || 0,
                note.comments || 0,
                new Date(note.timestamp).toLocaleString()
            ].map(csvEscape);
            return '"' + values.join('","') + '"';
        });

        const csvContent = csvHeader + csvRows.join('\n');
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `小红书笔记内容_${new Date().toLocaleDateString()}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // ---------- 初始化 ----------

    function initialize() {
        createPanel();
        const observerCallback = throttle(() => {
            ensurePanelExists();
            if (document.querySelector('.xhs-scraper-panel')) updateScrapeButton();
        }, 500);

        const observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
