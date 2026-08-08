# 展開先のコンテナ（スプレッドシート）の一覧
#
# このツールは複数のスプレッドシートへ同じコードを展開できる。
# 展開先を増やすときは、下の手順で TARGETS に名前を足し、3つの変数を定義する。
# Makefile 側は触らなくてよい。
#
#   NAME_<名前>      … 画面に出す表示名（どこへ出しているかの取り違え防止）
#   SCRIPT_ID_<名前> … GASプロジェクトのスクリプトID
#   DEPLOY_ID_<名前> … ウェブアプリのデプロイID（URLが変わらないよう使い回す）
#
# 新しいコンテナを増やす手順は README.md の「開発者向け ＞ 展開先を増やす」を参照。

TARGETS := main

NAME_main      := 本番
SCRIPT_ID_main := 1iXvovkvIfAkbg0Ee_cF9q7wYpsQ9hEx8XC-h_63KyLkMnHxNlRkvMW_K
DEPLOY_ID_main := AKfycbxMSxPCW7FiaQi7vs20EAfrIQ_M83EyHjGyu_3SCKYTB3qDPzTA0UnFhQD-dckI9hvt

# 2つ目以降はこの形で足す
#
# TARGETS += sub
# NAME_sub      := ○○支部
# SCRIPT_ID_sub := ...
# DEPLOY_ID_sub := ...
