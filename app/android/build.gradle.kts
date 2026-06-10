allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory = rootProject.layout.buildDirectory.dir("../../build").get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}

// AVATOK_FORCE_COMPILE_SDK: plugins (e.g. flutter_webrtc) pin a low compileSdk; override.
subprojects {
    if (name != "app") {
        afterEvaluate {
            extensions.findByName("android")?.let { ext ->
                runCatching {
                    (ext as com.android.build.gradle.BaseExtension).compileSdkVersion(36)
                }
            }
        }
    }
}

// AVATOK_KOTLIN_LANGVER: some plugins (e.g. posthog_flutter) pin Kotlin languageVersion 1.6,
// which the bundled Kotlin 2.x compiler rejects. Force a supported version on the
// affected subproject(s).
subprojects {
    if (name == "posthog_flutter") {
        afterEvaluate {
            tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
                compilerOptions {
                    languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
                    apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
                }
            }
        }
    }
}

// AVATOK_JVM_TARGET: align Java + Kotlin JVM target to 17 across plugin
// subprojects to avoid "Inconsistent JVM-target" (e.g. nostr_core_dart).
subprojects {
    if (name != "app") {
        afterEvaluate {
            extensions.findByName("android")?.let { ext ->
                runCatching {
                    (ext as com.android.build.gradle.BaseExtension).compileOptions.apply {
                        sourceCompatibility = JavaVersion.VERSION_17
                        targetCompatibility = JavaVersion.VERSION_17
                    }
                }
            }
            tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
                compilerOptions {
                    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
                }
            }
        }
    }
}
