# 汽水音乐 · MyGo Music

给 [MyGo Music](https://github.com/egoist/mygo-music) 用的汽水音乐插件。非官方，与字节跳动、汽水音乐没有关联。

用汽水音乐 App 扫码登录。登录态只留在这台电脑的插件数据里，设置里没有 Cookie 栏。

安装（需要 MyGo Music 0.1.8 或更新）：

[mygo-music://install-plugin?repo=Guyu23/mygo-music-qishui](mygo-music://install-plugin?repo=Guyu23/mygo-music-qishui)

也可以在 设置 → 插件 里粘贴：

```
https://github.com/Guyu23/mygo-music-qishui
```

## 能做什么

- 汽水音乐 App 扫码登录、退出
- 我的歌单（我喜欢的音乐、抖音收藏、自建歌单），以及公开歌单
- 为你推荐、推荐歌单、排行榜
- 听歌模式：默认、熟悉、新鲜，以及服务端下发的场景（图书馆、专注这一类）
- 逐字歌词
- 播放历史（登录后读取，开始播放时记一笔）
- 搜索歌曲、专辑、艺人和歌单

会员和版权以汽水音乐账号为准。接口只给试听地址时，播放的就是试听。加密音频不会在本地解密，这种歌会显示暂时不能播放。

## 开发

```bash
node --test
```

`test/plugin.test.mjs` 用假接口核对登录、歌单、推荐、听歌模式、歌词和播放地址。`test/live.test.mjs` 会访问汽水音乐的公开接口。
