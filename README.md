# servEX

ブラウザからサーバーのファイルを操作できるデュアルペインファイルマネージャーです。

## 特徴

- デュアルペインファイルブラウザ
- フォルダツリーエクスプローラ（左サイドバー）
- ドラッグ＆ドロップによるファイル操作
- ブラウザ内ターミナル
- ファイルアップロード / ダウンロード
- 権限・所有者の変更
- サムネイル表示 / リスト表示
- Tailscale Serve 対応

## インストール

### 必要なもの

- Node.js 18 以上
- Ubuntu / Debian（RHEL/CentOS もサポート）

### セットアップ

```bash
git clone https://github.com/hirogura/servex.git
cd servex
sudo bash install-servex.sh
```

セットアップスクリプトは以下を行います：

1. Node.js の自動インストール（未インストール時）
2. `/opt/servex` へのファイルコピー
3. `npm install` の実行
4. systemd サービスの作成・起動
5. Tailscale Serve の設定（Tailscale インストール済みの場合）

### 手動インストール

```bash
git clone https://github.com/hirogura/servex.git
cd servex/server
npm install --production
node server.js
```

デフォルトで `http://127.0.0.1:3359` で起動します。

## 設定

環境変数で設定を変更できます：

| 環境変数 | 説明 | デフォルト |
|---|---|---|
| `PORT` | 待受ポート | `3359` |
| `SERVEX_DIR` | インストールディレクトリ | `/opt/servex` |
| `SERVEX_SERVICE` | systemd サービス名 | `servex` |

## アンインストール

```bash
# サービス停止・無効化
sudo systemctl stop servex
sudo systemctl disable servex

# サービスファイル削除
sudo rm /etc/systemd/system/servex.service
sudo systemctl daemon-reload

# ファイル削除
sudo rm -rf /opt/servex

# Tailscale Serve 設定解除（Tailscale 使用時）
tailscale serve --bg --https=3359 --remove 2>/dev/null || true
```

## ライセンス

[MIT License](LICENSE)
