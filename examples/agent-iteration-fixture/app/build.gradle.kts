import groovy.json.JsonOutput
import java.io.File
import java.security.MessageDigest

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "com.example.picofixture.iteration"
    compileSdk = 35
    // Already installed locally; never let an example build provision a shared SDK component.
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.example.picofixture.iteration"
        minSdk = 35
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters.add("arm64-v8a") }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isDebuggable = false
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(platform(libs.spatial.bom))
    implementation(libs.spatial.core)
    implementation(libs.spatial.ui.platform)
    implementation(libs.spatial.ui.foundation)
    implementation(libs.spatial.ui.design)
    implementation(libs.spatial.ui.sense)
    implementation(libs.spatial.ui.tracking)
    implementation(libs.androidx.annotation)
    implementation(libs.androidx.appcompat)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

configurations.all {
    resolutionStrategy {
        exclude("androidx.compose.ui", "ui")
        exclude("androidx.compose.ui", "ui-graphics")
        exclude("androidx.compose.ui", "ui-text")
        exclude("androidx.compose.foundation", "foundation")
    }
}

// Actual resolved inputs for the deliberately single-module iteration fixture.
// This does not create a CLI WorkflowRun or claim generic external-module provenance.
tasks.register("writeIterationInputs") {
    group = "verification"
    description = "Record actual resolved debug artifacts and local toolchain identities."
    doLast {
        fun identity(file: File): Map<String, String> {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(65536)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            return mapOf("path" to file.canonicalPath, "sha256" to digest.digest().joinToString("") { "%02x".format(it) })
        }
        fun artifacts(configuration: org.gradle.api.artifacts.Configuration, name: String) =
            configuration.resolvedConfiguration.resolvedArtifacts.map { artifact ->
                identity(artifact.file) + mapOf("coordinate" to artifact.id.componentIdentifier.displayName, "configuration" to name)
            }.sortedBy { it.getValue("path") }
        val javaRoot = File(System.getProperty("java.home"))
        val dependencies = listOf("debugCompileClasspath", "debugRuntimeClasspath").flatMap { name ->
            artifacts(configurations.getByName(name), name)
        }
        val buildClasspath = listOf(project, rootProject).distinct().flatMap { owner ->
            owner.buildscript.configurations.findByName("classpath")?.let {
                artifacts(it, owner.path + ":buildscript:classpath")
            } ?: emptyList()
        }
        val compilerClasspath = configurations.filter { configuration ->
            configuration.isCanBeResolved && (
                configuration.name.contains("Compiler", ignoreCase = true) ||
                configuration.name.contains("aapt2", ignoreCase = true) ||
                configuration.name == "androidJdkImage"
            )
        }.flatMap { artifacts(it, it.name) }
        fun directoryIdentity(directory: File): Map<String, Any> {
            check(directory.isDirectory) { "Required build input directory unavailable: $directory" }
            return mapOf(
                "root" to directory.canonicalPath,
                "files" to directory.walkTopDown().filter { it.isFile }.map(::identity).sortedBy { it.getValue("path") }.toList(),
            )
        }
        val report = mapOf(
            "schemaVersion" to 1,
            "variant" to "debug",
            "packageName" to "com.example.picofixture.iteration.debug",
            "dependencies" to dependencies,
            "androidBootClasspath" to android.bootClasspath.map(::identity),
            "buildClasspath" to buildClasspath,
            "compilerClasspath" to compilerClasspath,
            "gradleInstallation" to directoryIdentity(gradle.gradleHomeDir ?: error("Gradle installation unavailable")),
            "androidBuildTools" to directoryIdentity(File(android.sdkDirectory, "build-tools/" + android.buildToolsVersion)),
            "androidPlatform" to directoryIdentity(File(android.sdkDirectory, "platforms/android-" + android.compileSdk)),
            "javaInstallation" to directoryIdentity(javaRoot),
            "debugSigningKey" to identity(android.signingConfigs.getByName("debug").storeFile ?: error("Debug signing key unavailable")),
            "toolchain" to mapOf(
                "javaVersion" to System.getProperty("java.version"),
                "javaHome" to javaRoot.canonicalPath,
                "gradleVersion" to gradle.gradleVersion,
                "javaExecutable" to identity(File(javaRoot, "bin/java")),
                "javaModules" to identity(File(javaRoot, "lib/modules")),
            ),
            "apkPath" to layout.buildDirectory.file("outputs/apk/debug/app-debug.apk").get().asFile.canonicalPath,
        )
        val output = layout.buildDirectory.file("iteration-inputs.json").get().asFile
        output.parentFile.mkdirs()
        output.writeText(JsonOutput.prettyPrint(JsonOutput.toJson(report)) + "\n")
    }
}
