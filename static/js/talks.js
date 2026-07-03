// Talks data — add a talk by adding one entry. Newest-first sorting is automatic.
// Each talk expands in place on the homepage: description paragraphs, event link,
// then slides (speakerdeck id) and video (youtube id) load on first expand.
window.TALKS = [
  {
    date: '2017-11-08',
    title: 'The Road to Single Dex',
    where: 'GDG SF Meetup',
    location: 'San Francisco, CA, USA',
    link: 'https://web.archive.org/web/20230121093345/https://gdg.community.dev/events/details/google-gdg-san-francisco-presents-interns-say-hello-often-the-road-to-single-dex-lean-android-applications/',
    speakerdeck: 'f87003a516e24a9fb11fcc119e535450',
    description: [
      'Lean Android applications with small APK sizes and low method counts are hard to come by nowadays as some of the most used libraries such as AppCompat and Play Services continue to grow in size. In an increasingly mobile first world, it important to try and maintain a lean application in order to avoid loading extra DEX files, slowing down local development builds and increasing the size of the updates you ship to your customers.',
      'This talk is centered around how I was able to lower Yammer for Android’s method count down to a single DEX and will give several tips on how to help you lower the number of methods and overall APK size of your application.'
    ]
  },
  {
    date: '2017-11-05',
    title: 'Make Your Build Great Again',
    where: 'Droidcon',
    location: 'San Francisco, CA, USA',
    link: 'https://web.archive.org/web/20171019135514/https://sf.droidcon.com/',
    speakerdeck: '4206b3835eb141ba84cb91cb95cef7f6',
    youtube: 'rvwAlbtbtmM',
    description: [
      'Slow builds have been plaguing Android development since the very beginning, especially for large multi-dex projects. As libraries tend to grow in size and the more libraries an application consumes it will slow down the build, especially when an application goes over the mutli-dex limit. Libraries aren\'t the only thing that can slow down the build, adding many Gradle plugins and repositories can increase the time it takes to configure the Gradle build. This talk will be centered around how I was able to decrease Yammer for Android\'s Gradle build times by optimizing our use of the Android Gradle plugin and the Gradle setup of our multi-project build and will give several tools and tips on how to help you profile and decrease your build times as well.'
    ]
  },
  {
    date: '2017-06-22',
    title: 'The Road to Single Dex',
    where: 'Gradle Summit',
    location: 'Palo Alto, CA, USA',
    link: 'https://web.archive.org/web/20170630105307/https://summit.gradle.com/',
    speakerdeck: 'f87003a516e24a9fb11fcc119e535450',
    youtube: 'ZmI-NZ1akow',
    description: [
      'Lean Android applications with small APK sizes and low method counts are hard to come by nowadays as some of the most used libraries such as AppCompat and Play Services continue to grow in size. In an increasingly mobile first world, it important to try and maintain a lean application in order to avoid loading extra DEX files, slowing down local development builds and increasing the size of the updates you ship to your customers.',
      'This talk is centered around how I was able to lower Yammer for Android’s method count down to a single DEX and will give several tips on how to help you lower the number of methods and overall APK size of your application.'
    ]
  }
];
