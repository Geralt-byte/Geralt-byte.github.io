---
layout: post
title: "记录Portainer容器忘记密码解决方法"
date: 2026-04-18 10:00:00 +0800
categories: [Docker]
tags: [Portainer, Docker, 密码重置, 容器管理]
---

## 问题背景

记录一次使用Docker容器管理软件Portainer忘记密码进行重置的过程。

![Portainer登录界面]({{ site.baseurl }}/assets/images/portainer/登录页面.png)

## 解决方案概述

通过容器挂载卷重置管理员账户密码，整个过程包括停止容器、查询容器信息、访问挂载点重置密码、重启容器验证。

---

## 详细操作步骤

### 步骤一：停止Portainer容器

首先需要停止正在运行的Portainer容器，以便进行后续操作。

```bash
# 查看正在运行的容器
docker ps

# 停止Portainer容器
docker stop portainer
```

![停止Docker容器]({{ site.baseurl }}/assets/images/portainer/stop.png)

**注意：** 确保在停止容器前没有正在进行的操作，避免数据丢失。

### 步骤二：查询容器详细信息

使用docker inspect命令查看容器的详细配置信息。

```bash
# 查询容器详细信息
docker inspect 279025fab87b
```

![容器详细信息]({{ site.baseurl }}/assets/images/portainer/inspect.png)


在输出信息中找到`Mounts`部分，定位到类似以下的挂载点信息：
```json
"Mounts": [
    {
        "Type": "volume",
        "Name": "e38a3d1c2b3e1cb2f8fbe6e6be37508b6cbc1cd56a732157b75272f1856948c9",
        "Destination": "/data",
        "Driver": "local",
        ...
    }
]
```

### 步骤三：访问挂载点并重置密码

进入挂载点目录，使用Portainer提供的密码重置工具进行密码重置。

```bash
# 进入挂载点目录
cd /var/lib/docker/volumes/e38a3d1c2b3e1cb2f8fbe6e6be37508b6cbc1cd56a732157b75272f1856948c9/_data/

# 使用密码重置工具
docker run --rm -v /var/lib/docker/volumes/e38a3d1c2b3e1cb2f8fbe6e6be37508b6cbc1cd56a732157b75272f1856948c9/_data:/data portainer/helper-reset-password
```

![密码重置过程]({{ site.baseurl }}/assets/images/portainer/reset.png)

**说明：** 命令执行后，系统会生成一个新的随机密码。例如：
```
uYqvNf0L1Ar75[2-P#at./$84}6l+mDj
```


### 步骤四：重启容器并验证

重启Portainer容器，使用新生成的密码登录并修改为自定义密码。

```bash
# 重启Portainer容器
docker start portainer
```

![登录成功界面]({{ site.baseurl }}/assets/images/portainer/success.png)
