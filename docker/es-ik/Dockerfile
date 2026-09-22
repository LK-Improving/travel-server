# 基于官方 Elasticsearch 8.11.3 镜像，离线内置 IK 中文分词插件（ik_max_word / ik_smart）
# IK 版本必须与 ES 主版本严格一致（8.11.3），否则插件无法加载。
FROM docker.elastic.co/elasticsearch/elasticsearch:8.11.3

# 预下载的 IK 插件 zip（构建上下文内的相对路径）
COPY elasticsearch-analysis-ik-8.11.3.zip /tmp/elasticsearch-analysis-ik-8.11.3.zip

# --batch 跳过交互式确认；file:// 指向容器内绝对路径
# 注意：官方镜像以 elasticsearch 用户运行，无法 rm 掉 /tmp 下 root 所有的 zip，
# 仅做安装即可（残留 zip 在 /tmp，不影响 ES 运行）。
RUN bin/elasticsearch-plugin install --batch file:///tmp/elasticsearch-analysis-ik-8.11.3.zip

EXPOSE 9200 9300
