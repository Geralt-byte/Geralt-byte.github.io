---
layout: post
title: "记录Portainer容器忘记密码解决方法"
date: 2026-04-18 10:00:00 +0800
categories: [Docker]
tags: [Portainer, Docker, 密码重置, 容器管理]
---

## 问题描述

记录一次使用docker容器管理软件portainer忘记密码进行重置的过程。

![Portainer登录界面]({{ site.baseurl }}/assets/images/portainer/登录页面.png)

## 解决方案

通过容器挂载卷重置管理员账户密码。
---
### 步骤1：停止Portainer容器

```bash
docker ps
docker stop portainer
```
![停止docker容器]({{ site.baseurl }}/assets/images/portainer/stop.png)

### 步骤2：查询容器详细信息

```bash
docker inspect 279025fab87b
```
![inspect]({{ site.baseurl }}/assets/images/portainer/inspect.png)
记录这里查找到的挂载点位置，访问挂载点。

### 步骤3：访问挂载点，重置管理员密码

```bash
cd /var/lib/docker/volumes/e38a3d1c2b3e1cb2f8fbe6e6be37508b6cbc1cd56a732157b75272f1856948c9/_data/
docker run --rm -v /var/lib/docker/volumes/e38a3d1c2b3e1cb2f8fbe6e6be37508b6cbc1cd56a732157b75272f1856948c9/_data:/data portainer/helper-reset-password
```
![inspect]({{ site.baseurl }}/assets/images/portainer/reset.png)
这里的uYqvNf0L1Ar75[2-P#at./$84}6l+mDj即为重置后的密码。

### 步骤4：重启容器，去登录页面访问并更改密码
```bash
docker start portainer
```
密码设置成功后，你就可以使用新密码登录Portainer管理界面，并修改密码。
![登录成功界面]({{ site.baseurl }}/assets/images/portainer/success.png)
---
