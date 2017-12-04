---
layout: presentation

event: Droidcon
location: San Francisco, CA, USA
homepage: https://sf.droidcon.com/
listing: https://sf.droidcon.com/
date: 2017-11-05

type: Technical

title: Make Your Build Great Again
speakerdeck: 4206b3835eb141ba84cb91cb95cef7f6
---

Slow builds have been plaguing Android development since the very beginning, especially for large multi-dex projects. As libraries tend to grow in size and the more libraries an application consumes it will slow down the build, especially when an application goes over the mutli-dex limit. Libraries aren't the only thing that can slow down the build, adding many Gradle plugins and repositories can increase the time it takes to configure the Gradle build. This talk will be centered around how I was able to decrease Yammer for Android's Gradle build times by optimizing our use of the Android Gradle plugin and the Gradle setup of our multi-project build and will give several tools and tips on how to help you profile and decrease your build times as well.
